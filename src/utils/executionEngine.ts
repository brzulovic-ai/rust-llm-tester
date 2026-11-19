import type {
  EndpointFileAttachment,
  ExecutionConfig,
  ModelRunResult,
  ProviderEndpoint,
  SystemPromptConfig,
  TargetModel,
} from '../types/benchmark';
import {
  base64ToUint8Array,
  filesForEndpoint,
  formatBytes,
  resolveEndpointUrl,
  shouldUseMultipartUpload,
} from './endpointUtils';
import {
  computeTimingMetrics,
  computeTokensPerSecond,
  createInitialTiming,
  estimateTokenCount,
  parseSseLines,
} from './metrics';

export interface RunTargetParams {
  target: TargetModel;
  provider: ProviderEndpoint;
  prompt: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: SystemPromptConfig;
  executionConfig: ExecutionConfig;
  endpointFiles?: EndpointFileAttachment[];
  enqueuedAt: number;
  signal: AbortSignal;
  onUpdate: (partial: ModelRunResult) => void;
}

export function resolveSystemPromptForTarget(
  target: TargetModel,
  systemPrompt: SystemPromptConfig
): string | undefined {
  if (target.systemPromptOverride && target.systemPromptOverride.trim()) {
    return target.systemPromptOverride.trim();
  }
  if (!systemPrompt.enabled || !systemPrompt.content.trim()) {
    return undefined;
  }
  if (systemPrompt.targetMode === 'all') {
    return systemPrompt.content.trim();
  }
  if (systemPrompt.targetModelIds.includes(target.id)) {
    return systemPrompt.content.trim();
  }
  return undefined;
}

export function modelDisallowsSamplingParams(modelName: string): boolean {
  const clean = (modelName.trim().toLowerCase().split('/').pop() ?? '').trim();
  return (
    clean === 'o1' ||
    clean.startsWith('o1-') ||
    clean === 'o3' ||
    clean.startsWith('o3-') ||
    clean === 'o4' ||
    clean.startsWith('o4-') ||
    clean === 'gpt-5' ||
    clean.startsWith('gpt-5-') ||
    clean.startsWith('gpt-5.') ||
    clean === 'deepseek-reasoner'
  );
}

export function parseCustomParamValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function stripUnsupportedParamsFor400(
  payload: Record<string, unknown>,
  errorText: string
): boolean {
  const lower = errorText.toLowerCase();
  let changed = false;

  const mentionsTemp =
    lower.includes('temperature') ||
    lower.includes('sampling') ||
    (lower.includes('unsupported') && lower.includes('parameter'));
  const mentionsTopP = lower.includes('top_p') || lower.includes('topp');
  const mentionsMaxTokens =
    lower.includes('max_tokens') &&
    (lower.includes('max_completion_tokens') ||
      lower.includes('unsupported') ||
      lower.includes('not supported'));

  const stripFromTarget = (obj: Record<string, unknown>): boolean => {
    let touched = false;
    if ((mentionsTemp || mentionsTopP) && 'temperature' in obj) {
      delete obj.temperature;
      touched = true;
    }
    if ((mentionsTemp || mentionsTopP) && 'top_p' in obj) {
      delete obj.top_p;
      touched = true;
    }
    if ((mentionsTemp || mentionsTopP) && 'topP' in obj) {
      delete obj.topP;
      touched = true;
    }
    if (mentionsMaxTokens && typeof obj.max_tokens === 'number') {
      obj.max_completion_tokens = obj.max_tokens;
      delete obj.max_tokens;
      touched = true;
    }
    return touched;
  };

  if (stripFromTarget(payload)) {
    changed = true;
  }
  if (payload.jsonBody && typeof payload.jsonBody === 'object' && !Array.isArray(payload.jsonBody)) {
    if (stripFromTarget(payload.jsonBody as Record<string, unknown>)) {
      changed = true;
    }
  }
  return changed;
}

export async function executeSingleTarget(params: RunTargetParams): Promise<ModelRunResult> {
  const {
    target,
    provider,
    prompt,
    historyMessages,
    systemPrompt,
    executionConfig,
    endpointFiles = [],
    enqueuedAt,
    signal,
    onUpdate,
  } = params;

  const endpointType = executionConfig.endpointType ?? 'chat-completions';
  const act = executionConfig.activeParams ?? {};
  const useCustomHeaders = act.customHeaders !== false;
  const useCustomEndpoint = act.customEndpoint !== false;
  const useStream = act.stream !== false && executionConfig.stream;
  const useTemperature = act.temperature !== false;
  const useTopP = act.topP !== false;
  const useMaxTokens = act.maxTokens !== false;
  const useSeed = act.seed !== false;
  const useTtsVoice = act.ttsVoice !== false;
  const useFiles = act.endpointFiles !== false;

  const effectiveCustomHeaders = useCustomHeaders ? provider.customHeaders : {};
  const resolvedExtraParams: Record<string, unknown> = {};
  for (const param of executionConfig.extraParams ?? []) {
    if (param.enabled && param.key.trim()) {
      resolvedExtraParams[param.key.trim()] = parseCustomParamValue(param.value);
    }
  }

  const matchedFiles = useFiles ? filesForEndpoint(endpointFiles, endpointType) : [];
  const resolvedUrl =
    provider.kind === 'gemini-builtin' && endpointType === 'chat-completions'
      ? '/api/gemini/chat'
      : resolveEndpointUrl(
          provider.baseUrl,
          endpointType,
          useCustomEndpoint ? executionConfig.customEndpoint : undefined
        );

  const fileSections =
    (endpointType === 'chat-completions' ||
      endpointType === 'responses' ||
      endpointType === 'embeddings') &&
    matchedFiles.length > 0
      ? matchedFiles
          .map((f) =>
            f.textPreview
              ? `--- Attached File: ${f.name} (${f.mimeType}, ${formatBytes(f.sizeBytes)}) ---\n${f.textPreview}`
              : `[Attached binary file: ${f.name} (${f.mimeType}, ${formatBytes(f.sizeBytes)})]`
          )
          .join('\n\n')
      : '';

  const appliedSystemPrompt = resolveSystemPromptForTarget(target, systemPrompt);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (appliedSystemPrompt) {
    messages.push({ role: 'system', content: appliedSystemPrompt });
  }

  let effectivePrompt = prompt;
  if (historyMessages && historyMessages.length > 0) {
    const cleaned = historyMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const lastUserIdx = [...cleaned].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx !== -1) {
      const targetIdx = cleaned.length - 1 - lastUserIdx;
      effectivePrompt = fileSections
        ? `${cleaned[targetIdx].content}\n\n${fileSections}`.trim()
        : cleaned[targetIdx].content;
      cleaned[targetIdx] = { ...cleaned[targetIdx], content: effectivePrompt };
    } else if (fileSections) {
      effectivePrompt = `${prompt}\n\n${fileSections}`.trim();
    }
    messages.push(...cleaned);
  } else {
    if (fileSections) {
      effectivePrompt = `${prompt}\n\n${fileSections}`.trim();
    }
    messages.push({ role: 'user', content: effectivePrompt });
  }

  const startedAt = performance.now();
  let timing = computeTimingMetrics(
    {
      ...createInitialTiming(enqueuedAt),
      startedAt,
    },
    startedAt
  );

  let currentResult: ModelRunResult = {
    targetId: target.id,
    modelName: target.modelName,
    providerName: provider.name,
    providerKind: provider.kind,
    status: 'connecting',
    output: '',
    promptTokens: estimateTokenCount(
      (appliedSystemPrompt ? `${appliedSystemPrompt}\n` : '') + effectivePrompt
    ),
    completionTokens: 0,
    totalTokens: 0,
    tokensPerSec: 0,
    timing,
    systemPromptApplied: appliedSystemPrompt,
    endpointUrl: resolvedUrl,
  };

  onUpdate(currentResult);

  if (
    (endpointType === 'audio-transcriptions' || endpointType === 'audio-translations') &&
    matchedFiles.length === 0
  ) {
    const completedAt = performance.now();
    timing = computeTimingMetrics({ ...timing, completedAt }, completedAt);
    const missingFileResult: ModelRunResult = {
      ...currentResult,
      status: 'error',
      error: `Endpoint ${endpointType === 'audio-transcriptions' ? '/v1/audio/transcriptions' : '/v1/audio/translations'} requires an attached audio file.`,
      advice: 'Upload or attach an audio file scoped to this endpoint in Configuration & Models -> Endpoint File Manager.',
      timing,
    };
    onUpdate(missingFileResult);
    return missingFileResult;
  }

  const timeoutMs = Math.min(Math.max((executionConfig.timeoutSec || 300) * 1000, 1000), 600000);
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort('timeout'), timeoutMs);

  const combinedController = new AbortController();
  const onParentAbort = () => combinedController.abort('cancelled');
  const onTimeoutAbort = () => combinedController.abort('timeout');
  signal.addEventListener('abort', onParentAbort);
  timeoutController.signal.addEventListener('abort', onTimeoutAbort);

  try {
    let fetchTargetUrl = '/api/proxy/chat';
    let fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    let fetchBodyPayload: BodyInit;

    const useMultipart = shouldUseMultipartUpload(
      endpointType,
      executionConfig.customPayloadMode ?? 'auto',
      matchedFiles
    );

    const disallowSampling = modelDisallowsSamplingParams(target.modelName);
    let mutableJsonPayload: Record<string, unknown> | null = null;

    if (endpointType === 'chat-completions') {
      if (provider.kind === 'gemini-builtin') {
        fetchTargetUrl = '/api/gemini/chat';
        mutableJsonPayload = {
          model: target.modelName,
          messages,
          stream: useStream,
          timeoutMs,
          ...(useSeed && typeof executionConfig.seed === 'number'
            ? { seed: executionConfig.seed }
            : {}),
          ...resolvedExtraParams,
        };
        fetchBodyPayload = JSON.stringify(mutableJsonPayload);
      } else if (provider.directBrowser) {
        fetchTargetUrl = resolvedUrl;
        fetchHeaders = {
          'Content-Type': 'application/json',
          ...effectiveCustomHeaders,
        };
        if (provider.apiKey && !fetchHeaders['Authorization'] && !fetchHeaders['authorization']) {
          fetchHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
        }
        mutableJsonPayload = {
          model: target.modelName,
          messages,
          stream: useStream,
          ...(!disallowSampling && useTemperature
            ? { temperature: executionConfig.temperature }
            : {}),
          ...(!disallowSampling && useTopP ? { top_p: executionConfig.topP } : {}),
          ...(useMaxTokens && executionConfig.maxTokens > 0
            ? { max_tokens: executionConfig.maxTokens }
            : {}),
          ...(useSeed && typeof executionConfig.seed === 'number'
            ? { seed: executionConfig.seed }
            : {}),
          ...(useStream ? { stream_options: { include_usage: true } } : {}),
          ...resolvedExtraParams,
        };
        fetchBodyPayload = JSON.stringify(mutableJsonPayload);
      } else {
        fetchTargetUrl = '/api/proxy/chat';
        mutableJsonPayload = {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          headers: effectiveCustomHeaders,
          model: target.modelName,
          messages,
          stream: useStream,
          ...(!disallowSampling && useTemperature
            ? { temperature: executionConfig.temperature }
            : {}),
          ...(!disallowSampling && useTopP ? { topP: executionConfig.topP } : {}),
          ...(useMaxTokens ? { maxTokens: executionConfig.maxTokens } : {}),
          ...(useSeed && typeof executionConfig.seed === 'number'
            ? { seed: executionConfig.seed }
            : {}),
          ...(Object.keys(resolvedExtraParams).length > 0
            ? { extraParams: resolvedExtraParams }
            : {}),
          timeoutMs,
        };
        fetchBodyPayload = JSON.stringify(mutableJsonPayload);
      }
    } else if (useMultipart) {
      const fields: Record<string, string> = { model: target.modelName };
      if (effectivePrompt.trim()) {
        fields.prompt = effectivePrompt.trim();
      }
      if (provider.directBrowser) {
        fetchTargetUrl = resolvedUrl;
        fetchHeaders = { ...effectiveCustomHeaders };
        delete fetchHeaders['Content-Type'];
        delete fetchHeaders['content-type'];
        if (provider.apiKey && !fetchHeaders['Authorization'] && !fetchHeaders['authorization']) {
          fetchHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
        }
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) {
          form.append(k, v);
        }
        for (const f of matchedFiles) {
          const bytes = base64ToUint8Array(f.base64Data);
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          form.append(
            f.fieldName || 'file',
            new Blob([copy.buffer], { type: f.mimeType || 'application/octet-stream' }),
            f.name
          );
        }
        fetchBodyPayload = form;
      } else {
        fetchTargetUrl = '/api/proxy/endpoint';
        fetchBodyPayload = JSON.stringify({
          endpointUrl: resolvedUrl,
          apiKey: provider.apiKey,
          headers: effectiveCustomHeaders,
          multipart: true,
          fields,
          files: matchedFiles.map((f) => ({
            fieldName: f.fieldName || 'file',
            name: f.name,
            mimeType: f.mimeType,
            base64Data: f.base64Data,
          })),
          timeoutMs,
        });
      }
    } else {
      // Structured JSON for audio/speech, embeddings, responses, or custom JSON endpoint
      let jsonBody: Record<string, unknown>;
      if (endpointType === 'audio-speech') {
        jsonBody = {
          model: target.modelName,
          input: effectivePrompt,
          ...(useTtsVoice ? { voice: executionConfig.ttsVoice || 'alloy' } : {}),
          response_format: 'mp3',
          ...resolvedExtraParams,
        };
      } else if (endpointType === 'embeddings') {
        jsonBody = {
          model: target.modelName,
          input: effectivePrompt,
          ...resolvedExtraParams,
        };
      } else if (endpointType === 'responses') {
        jsonBody = {
          model: target.modelName,
          input: effectivePrompt,
          ...(appliedSystemPrompt ? { instructions: appliedSystemPrompt } : {}),
          ...(!disallowSampling && useTemperature
            ? { temperature: executionConfig.temperature }
            : {}),
          ...(useMaxTokens && executionConfig.maxTokens > 0
            ? { max_output_tokens: executionConfig.maxTokens }
            : {}),
          stream: useStream,
          ...resolvedExtraParams,
        };
      } else {
        jsonBody = {
          model: target.modelName,
          input: effectivePrompt,
          messages,
          ...(!disallowSampling && useTemperature
            ? { temperature: executionConfig.temperature }
            : {}),
          ...(!disallowSampling && useTopP ? { top_p: executionConfig.topP } : {}),
          ...(useMaxTokens && executionConfig.maxTokens > 0
            ? { max_tokens: executionConfig.maxTokens }
            : {}),
          ...(matchedFiles.length > 0
            ? {
                files: matchedFiles.map((f) => ({
                  name: f.name,
                  mimeType: f.mimeType,
                  textPreview: f.textPreview,
                  base64Data: f.textPreview ? undefined : f.base64Data,
                })),
              }
            : {}),
          ...resolvedExtraParams,
        };
      }

      if (provider.directBrowser) {
        fetchTargetUrl = resolvedUrl;
        fetchHeaders = {
          'Content-Type': 'application/json',
          ...effectiveCustomHeaders,
        };
        if (provider.apiKey && !fetchHeaders['Authorization'] && !fetchHeaders['authorization']) {
          fetchHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
        }
        mutableJsonPayload = jsonBody;
        fetchBodyPayload = JSON.stringify(mutableJsonPayload);
      } else {
        fetchTargetUrl = '/api/proxy/endpoint';
        mutableJsonPayload = {
          endpointUrl: resolvedUrl,
          apiKey: provider.apiKey,
          headers: effectiveCustomHeaders,
          multipart: false,
          jsonBody,
          timeoutMs,
        };
        fetchBodyPayload = JSON.stringify(mutableJsonPayload);
      }
    }

    let response = await fetch(fetchTargetUrl, {
      method: 'POST',
      headers: fetchHeaders,
      body: fetchBodyPayload,
      signal: combinedController.signal,
    });

    let headersAt = performance.now();
    timing = computeTimingMetrics({ ...timing, headersAt }, headersAt);

    const readErrorBody = async (resp: Response): Promise<string> => {
      if (typeof resp.text === 'function') {
        return resp.text().catch(() => '');
      }
      if (typeof resp.json === 'function') {
        return resp
          .json()
          .then((d) => JSON.stringify(d))
          .catch(() => '');
      }
      return '';
    };

    let preReadErrBody: string | null = null;
    if (!response.ok && response.status === 400 && mutableJsonPayload) {
      preReadErrBody = await readErrorBody(response);
      if (stripUnsupportedParamsFor400(mutableJsonPayload, preReadErrBody)) {
        response = await fetch(fetchTargetUrl, {
          method: 'POST',
          headers: fetchHeaders,
          body: JSON.stringify(mutableJsonPayload),
          signal: combinedController.signal,
        });
        headersAt = performance.now();
        timing = computeTimingMetrics({ ...timing, headersAt }, headersAt);
        preReadErrBody = null;
      }
    }

    if (!response.ok) {
      let errMessage = `HTTP ${response.status} ${response.statusText}`;
      let advice: string | undefined;
      const errText = preReadErrBody ?? (await readErrorBody(response));
      if (errText) {
        try {
          const errJson = JSON.parse(errText) as {
            error?: string | { message?: string };
            details?: string;
            advice?: string;
          };
          if (typeof errJson.error === 'string') {
            errMessage = errJson.error;
          } else if (errJson.error?.message) {
            errMessage = errJson.error.message;
          }
          if (errJson.details) {
            errMessage += `: ${errJson.details}`;
          }
          advice = errJson.advice;
        } catch {
          errMessage += `: ${errText.slice(0, 300)}`;
        }
      }

      const completedAt = performance.now();
      timing = computeTimingMetrics({ ...timing, completedAt }, completedAt);
      const failedResult: ModelRunResult = {
        ...currentResult,
        status: 'error',
        httpStatus: response.status,
        error: errMessage,
        advice:
          advice ||
          (response.status === 429
            ? 'Rate limit exceeded (429). Lower parallel concurrency or wait before retrying.'
            : response.status === 402
            ? 'Quota or credits exhausted (402). Check provider billing/free-tier balance.'
            : response.status === 401 || response.status === 403
            ? 'Check your API key or Authorization header.'
            : response.status === 404
            ? 'Verify base URL and model name.'
            : response.status >= 500
            ? `Upstream provider error (HTTP ${response.status}). Retry or test another model.`
            : 'Check provider logs and retry.'),
        timing,
      };
      onUpdate(failedResult);
      return failedResult;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (useStream && contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let accumulatedText = '';
      let firstTokenAt: number | null = null;
      let promptTokens = currentResult.promptTokens;
      let completionTokens = 0;
      let totalTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const chunkStr = decoder.decode(value, { stream: true });
        const { events, nextBuffer } = parseSseLines(chunkStr, sseBuffer);
        sseBuffer = nextBuffer;

        for (const ev of events) {
          if (ev.error) {
            const completedAt = performance.now();
            timing = computeTimingMetrics({ ...timing, firstTokenAt, completedAt }, completedAt);
            const errCodeMatch = ev.error.match(/\b(400|401|402|403|404|408|413|422|429|500|502|503|504)\b/);
            const inferredCode =
              response.status && response.status !== 200
                ? response.status
                : errCodeMatch
                ? Number(errCodeMatch[1])
                : undefined;
            const errResult: ModelRunResult = {
              ...currentResult,
              status: 'error',
              httpStatus: inferredCode,
              output: accumulatedText,
              error: ev.error,
              advice: ev.advice,
              timing,
            };
            onUpdate(errResult);
            return errResult;
          }

          if (ev.usage) {
            if (ev.usage.promptTokens > 0) promptTokens = ev.usage.promptTokens;
            if (ev.usage.completionTokens > 0) completionTokens = ev.usage.completionTokens;
            if (ev.usage.totalTokens > 0) totalTokens = ev.usage.totalTokens;
          }

          if (ev.contentDelta) {
            const now = performance.now();
            if (firstTokenAt === null) {
              firstTokenAt = now;
            }
            accumulatedText += ev.contentDelta;
            const estCompletion = completionTokens || estimateTokenCount(accumulatedText);
            timing = computeTimingMetrics({ ...timing, firstTokenAt }, now);
            const speed = computeTokensPerSecond(estCompletion, timing);

            currentResult = {
              ...currentResult,
              status: 'streaming',
              output: accumulatedText,
              promptTokens,
              completionTokens: estCompletion,
              totalTokens: totalTokens || promptTokens + estCompletion,
              tokensPerSec: speed,
              timing,
            };
            onUpdate(currentResult);
          }
        }
      }

      const completedAt = performance.now();
      const finalCompletionTokens = completionTokens || estimateTokenCount(accumulatedText);
      const finalTotalTokens = totalTokens || promptTokens + finalCompletionTokens;
      timing = computeTimingMetrics(
        { ...timing, firstTokenAt: firstTokenAt ?? completedAt, completedAt },
        completedAt
      );

      const finalResult: ModelRunResult = {
        ...currentResult,
        status: 'completed',
        httpStatus: response.status,
        output: accumulatedText,
        promptTokens,
        completionTokens: finalCompletionTokens,
        totalTokens: finalTotalTokens,
        tokensPerSec: computeTokensPerSecond(finalCompletionTokens, timing),
        timing,
      };
      onUpdate(finalResult);
      return finalResult;
    } else if (
      contentType.startsWith('audio/') ||
      contentType.includes('application/octet-stream')
    ) {
      const buf = await response.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(bin);
      const cleanMime = contentType.split(';')[0].trim() || 'audio/mpeg';
      const completedAt = performance.now();
      timing = computeTimingMetrics(
        { ...timing, firstTokenAt: headersAt, completedAt },
        completedAt
      );
      const audioSummary = `Generated audio response (${cleanMime}, ${formatBytes(bytes.byteLength)}) from ${resolvedUrl}`;
      const finalResult: ModelRunResult = {
        ...currentResult,
        status: 'completed',
        httpStatus: response.status,
        output: audioSummary,
        audioDataUrl: `data:${cleanMime};base64,${b64}`,
        completionTokens: 1,
        totalTokens: currentResult.promptTokens + 1,
        tokensPerSec: 0,
        timing,
      };
      onUpdate(finalResult);
      return finalResult;
    } else {
      // Non-streaming JSON / binary-wrapper / text response
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        text?: string;
        output_text?: string;
        binaryBase64?: string;
        mimeType?: string;
        sizeBytes?: number;
        data?: Array<{ embedding?: number[]; url?: string; b64_json?: string }>;
        [key: string]: unknown;
      };
      const completedAt = performance.now();

      let audioDataUrl: string | undefined;
      let text = '';
      if (data.binaryBase64) {
        const mime = data.mimeType || 'audio/mpeg';
        const sizeLabel = formatBytes(data.sizeBytes ?? Math.floor((data.binaryBase64.length * 3) / 4));
        if (mime.startsWith('audio/')) {
          audioDataUrl = `data:${mime};base64,${data.binaryBase64}`;
        }
        text = `Binary response (${mime}, ${sizeLabel}) from ${resolvedUrl}`;
      } else if (data.choices?.[0]?.message?.content !== undefined) {
        text = data.choices[0].message.content ?? '';
      } else if (typeof data.output_text === 'string') {
        text = data.output_text;
      } else if (typeof data.text === 'string') {
        text = data.text;
      } else if (Array.isArray(data.data) && Array.isArray(data.data[0]?.embedding)) {
        const vec = data.data[0].embedding;
        const preview = vec.slice(0, 8).map((v) => v.toFixed(5)).join(', ');
        text = `Embedding Vector (${vec.length} dimensions)\n[${preview}${vec.length > 8 ? ', ...' : ''}]`;
      } else {
        text = JSON.stringify(data, null, 2);
      }

      const promptTokens = data.usage?.prompt_tokens ?? currentResult.promptTokens;
      const completionTokens = data.usage?.completion_tokens ?? estimateTokenCount(text);
      const totalTokens = data.usage?.total_tokens ?? promptTokens + completionTokens;

      timing = computeTimingMetrics(
        { ...timing, firstTokenAt: headersAt, completedAt },
        completedAt
      );

      const finalResult: ModelRunResult = {
        ...currentResult,
        status: 'completed',
        httpStatus: response.status,
        output: text,
        audioDataUrl,
        promptTokens,
        completionTokens,
        totalTokens,
        tokensPerSec: computeTokensPerSecond(completionTokens, timing),
        timing,
      };
      onUpdate(finalResult);
      return finalResult;
    }
  } catch (err: unknown) {
    const completedAt = performance.now();
    timing = computeTimingMetrics({ ...timing, completedAt }, completedAt);
    const reason = combinedController.signal.reason;
    const isTimeout = reason === 'timeout';
    const isCancelled = reason === 'cancelled';
    const errObj = err as { message?: string };

    const result: ModelRunResult = {
      ...currentResult,
      status: isCancelled ? 'aborted' : 'error',
      error: isCancelled
        ? 'Run aborted by user'
        : isTimeout
        ? `Request timed out after ${executionConfig.timeoutSec}s`
        : errObj?.message || 'Network connection failed',
      advice: isTimeout
        ? 'Increase timeout limit in Configuration or disable streaming if the proxy buffers responses.'
        : isCancelled
        ? undefined
        : provider.directBrowser
        ? 'Direct Browser Mode failed (possible CORS block or local server offline). Ensure Ollama/LM Studio has CORS enabled or switch to Server Proxy.'
        : 'Verify provider Base URL and network reachability.',
      timing,
    };
    onUpdate(result);
    return result;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', onParentAbort);
    timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
  }
}

export interface RunPoolOptions {
  targets: TargetModel[];
  providers: ProviderEndpoint[];
  prompt: string;
  systemPrompt: SystemPromptConfig;
  executionConfig: ExecutionConfig;
  endpointFiles?: EndpointFileAttachment[];
  signal: AbortSignal;
  onResultUpdate: (targetId: string, result: ModelRunResult) => void;
}

/**
 * Returns a randomly shuffled shallow copy using Fisher-Yates.
 */
export function shuffleItems<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Executes a batch of model targets using either sequential (concurrency=1)
 * or parallel worker pool (concurrency 1..100).
 */
export async function runExecutionPool(options: RunPoolOptions): Promise<ModelRunResult[]> {
  const {
    targets,
    providers,
    prompt,
    systemPrompt,
    executionConfig,
    endpointFiles = [],
    signal,
    onResultUpdate,
  } = options;

  if (targets.length === 0) return [];

  const orderedTargets = executionConfig.randomizeOrder ? shuffleItems(targets) : targets;

  const workerCount =
    executionConfig.mode === 'sequential'
      ? 1
      : Math.min(Math.max(executionConfig.concurrency || 3, 1), 100);

  const enqueuedAt = performance.now();
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const finalResults = new Array<ModelRunResult>(orderedTargets.length);

  // Initialize queued state immediately
  orderedTargets.forEach((target) => {
    const provider = providerMap.get(target.providerId);
    onResultUpdate(target.id, {
      targetId: target.id,
      modelName: target.modelName,
      providerName: provider?.name ?? target.providerName,
      providerKind: provider?.kind ?? target.providerKind,
      status: 'queued',
      output: '',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokensPerSec: 0,
      timing: createInitialTiming(enqueuedAt),
    });
  });

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < orderedTargets.length) {
      if (signal.aborted) break;
      const idx = nextIndex++;
      const target = orderedTargets[idx];
      const provider = providerMap.get(target.providerId);

      if (!provider) {
        const missingErr: ModelRunResult = {
          targetId: target.id,
          modelName: target.modelName,
          providerName: target.providerName,
          providerKind: target.providerKind,
          status: 'error',
          output: '',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          tokensPerSec: 0,
          timing: createInitialTiming(enqueuedAt),
          error: 'Provider configuration not found',
          advice: 'Re-select a valid provider endpoint for this model.',
        };
        finalResults[idx] = missingErr;
        onResultUpdate(target.id, missingErr);
        continue;
      }

      const res = await executeSingleTarget({
        target,
        provider,
        prompt,
        systemPrompt,
        executionConfig,
        endpointFiles,
        enqueuedAt,
        signal,
        onUpdate: (partial) => onResultUpdate(target.id, partial),
      });
      finalResults[idx] = res;
    }
  }

  const workers = Array.from({ length: Math.min(workerCount, orderedTargets.length) }, () => worker());
  await Promise.all(workers);

  return finalResults.filter(Boolean);
}

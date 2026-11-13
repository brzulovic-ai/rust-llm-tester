import type {
  ExecutionConfig,
  ModelRunResult,
  ProviderEndpoint,
  SystemPromptConfig,
  TargetModel,
} from '../types/benchmark';
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
  systemPrompt: SystemPromptConfig;
  executionConfig: ExecutionConfig;
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

export async function executeSingleTarget(params: RunTargetParams): Promise<ModelRunResult> {
  const { target, provider, prompt, systemPrompt, executionConfig, enqueuedAt, signal, onUpdate } =
    params;

  const appliedSystemPrompt = resolveSystemPromptForTarget(target, systemPrompt);
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (appliedSystemPrompt) {
    messages.push({ role: 'system', content: appliedSystemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

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
      (appliedSystemPrompt ? `${appliedSystemPrompt}\n` : '') + prompt
    ),
    completionTokens: 0,
    totalTokens: 0,
    tokensPerSec: 0,
    timing,
    systemPromptApplied: appliedSystemPrompt,
  };

  onUpdate(currentResult);

  const timeoutMs = Math.min(Math.max((executionConfig.timeoutSec || 300) * 1000, 1000), 600000);
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort('timeout'), timeoutMs);

  const combinedController = new AbortController();
  const onParentAbort = () => combinedController.abort('cancelled');
  const onTimeoutAbort = () => combinedController.abort('timeout');
  signal.addEventListener('abort', onParentAbort);
  timeoutController.signal.addEventListener('abort', onTimeoutAbort);

  try {
    let endpointUrl = '/api/proxy/chat';
    let fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    let fetchBody: Record<string, unknown>;

    if (provider.kind === 'gemini-builtin') {
      endpointUrl = '/api/gemini/chat';
      fetchBody = {
        model: target.modelName,
        messages,
        stream: executionConfig.stream,
        timeoutMs,
        seed: executionConfig.seed,
      };
    } else if (provider.directBrowser) {
      const cleanBase = provider.baseUrl.trim().replace(/\/+$/, '');
      endpointUrl = `${cleanBase}/chat/completions`;
      fetchHeaders = {
        'Content-Type': 'application/json',
        ...provider.customHeaders,
      };
      if (provider.apiKey && !fetchHeaders['Authorization'] && !fetchHeaders['authorization']) {
        fetchHeaders['Authorization'] = `Bearer ${provider.apiKey}`;
      }
      fetchBody = {
        model: target.modelName,
        messages,
        stream: executionConfig.stream,
        temperature: executionConfig.temperature,
        top_p: executionConfig.topP,
        ...(executionConfig.maxTokens > 0 ? { max_tokens: executionConfig.maxTokens } : {}),
        ...(typeof executionConfig.seed === 'number' ? { seed: executionConfig.seed } : {}),
        ...(executionConfig.stream ? { stream_options: { include_usage: true } } : {}),
      };
    } else {
      fetchBody = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        headers: provider.customHeaders,
        model: target.modelName,
        messages,
        stream: executionConfig.stream,
        temperature: executionConfig.temperature,
        maxTokens: executionConfig.maxTokens,
        topP: executionConfig.topP,
        seed: executionConfig.seed,
        timeoutMs,
      };
    }

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(fetchBody),
      signal: combinedController.signal,
    });

    const headersAt = performance.now();
    timing = computeTimingMetrics({ ...timing, headersAt }, headersAt);

    if (!response.ok) {
      let errMessage = `HTTP ${response.status} ${response.statusText}`;
      let advice: string | undefined;
      try {
        const errJson = (await response.json()) as {
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
        const text = await response.text().catch(() => '');
        if (text) errMessage += `: ${text.slice(0, 300)}`;
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
          (response.status === 401
            ? 'Check your API key or Authorization header.'
            : response.status === 404
            ? 'Verify base URL and model name.'
            : 'Check provider logs and retry.'),
        timing,
      };
      onUpdate(failedResult);
      return failedResult;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (executionConfig.stream && contentType.includes('text/event-stream') && response.body) {
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
            const errResult: ModelRunResult = {
              ...currentResult,
              status: 'error',
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
    } else {
      // Non-streaming JSON response
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const completedAt = performance.now();
      const text = data.choices?.[0]?.message?.content ?? '';
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
  signal: AbortSignal;
  onResultUpdate: (targetId: string, result: ModelRunResult) => void;
}

/**
 * Executes a batch of model targets using either sequential (concurrency=1)
 * or parallel worker pool (concurrency 1..10).
 */
export async function runExecutionPool(options: RunPoolOptions): Promise<ModelRunResult[]> {
  const { targets, providers, prompt, systemPrompt, executionConfig, signal, onResultUpdate } =
    options;

  if (targets.length === 0) return [];

  const workerCount =
    executionConfig.mode === 'sequential'
      ? 1
      : Math.min(Math.max(executionConfig.concurrency || 3, 1), 10);

  const enqueuedAt = performance.now();
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const finalResults = new Array<ModelRunResult>(targets.length);

  // Initialize queued state immediately
  targets.forEach((target) => {
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
    while (nextIndex < targets.length) {
      if (signal.aborted) break;
      const idx = nextIndex++;
      const target = targets[idx];
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
        enqueuedAt,
        signal,
        onUpdate: (partial) => onResultUpdate(target.id, partial),
      });
      finalResults[idx] = res;
    }
  }

  const workers = Array.from({ length: Math.min(workerCount, targets.length) }, () => worker());
  await Promise.all(workers);

  return finalResults.filter(Boolean);
}

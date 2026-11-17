import type {
  BenchmarkRunRecord,
  ExecutionConfig,
  ModelRunResult,
  ProviderKind,
  RunStatus,
  SystemPromptConfig,
} from '../types/benchmark';

function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvExport(results: ModelRunResult[], prompt: string): string {
  const headers = [
    'Model',
    'Provider',
    'Status',
    'Queue (ms)',
    'Request (ms)',
    'TTFB (ms)',
    'Download (ms)',
    'Total (ms)',
    'Speed (tok/s)',
    'Prompt Tokens',
    'Completion Tokens',
    'Total Tokens',
    'HTTP Status',
    'Error',
    'Prompt',
    'Output',
  ];

  const rows = results.map((r) => [
    r.modelName,
    r.providerName,
    r.status,
    Math.round(r.timing.queueMs),
    Math.round(r.timing.requestMs),
    r.timing.ttfbMs !== null ? Math.round(r.timing.ttfbMs) : '',
    Math.round(r.timing.downloadMs),
    Math.round(r.timing.totalMs),
    r.tokensPerSec,
    r.promptTokens,
    r.completionTokens,
    r.totalTokens,
    r.httpStatus ?? '',
    r.error ?? '',
    prompt,
    r.output,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\n');
}

export function buildJsonExport(run: BenchmarkRunRecord): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      workbench: 'LLM Multi-Tester & Benchmark Workbench',
      run,
    },
    null,
    2
  );
}

const VALID_RUN_STATUSES = new Set<RunStatus>([
  'idle',
  'queued',
  'connecting',
  'streaming',
  'completed',
  'error',
  'aborted',
]);

function normalizeImportedResult(raw: unknown, idx: number): ModelRunResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawTiming = (r.timing && typeof r.timing === 'object' ? r.timing : {}) as Record<string, unknown>;
  const rawStatus = typeof r.status === 'string' ? r.status.toLowerCase() : 'completed';
  const status: RunStatus = VALID_RUN_STATUSES.has(rawStatus as RunStatus)
    ? (rawStatus as RunStatus)
    : rawStatus === 'failed'
    ? 'error'
    : 'completed';

  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const offsetMs = num(rawTiming.offset_ms, 0);
  const enqueuedAt = num(rawTiming.enqueuedAt, offsetMs);
  const startedAt = num(rawTiming.startedAt, enqueuedAt + num(rawTiming.queueMs ?? rawTiming.queue_ms, 0));
  const ttfbVal =
    rawTiming.ttfbMs !== undefined
      ? (rawTiming.ttfbMs as number | null)
      : rawTiming.ttfb_ms !== undefined
      ? (rawTiming.ttfb_ms as number | null)
      : null;

  return {
    targetId: String(r.targetId ?? r.target_id ?? `imported-target-${idx}`),
    modelName: String(r.modelName ?? r.model_name ?? `Model ${idx + 1}`),
    providerName: String(r.providerName ?? r.provider_name ?? 'Imported'),
    providerKind: ((r.providerKind ?? r.provider_kind ?? 'custom') as ProviderKind),
    status,
    output: typeof r.output === 'string' ? r.output : '',
    promptTokens: num(r.promptTokens ?? r.prompt_tokens, 0),
    completionTokens: num(r.completionTokens ?? r.completion_tokens, 0),
    totalTokens: num(r.totalTokens ?? r.total_tokens, 0),
    tokensPerSec: num(r.tokensPerSec ?? r.tokens_per_sec, 0),
    timing: {
      enqueuedAt,
      startedAt,
      headersAt: typeof rawTiming.headersAt === 'number' ? rawTiming.headersAt : null,
      firstTokenAt: typeof rawTiming.firstTokenAt === 'number' ? rawTiming.firstTokenAt : null,
      completedAt: typeof rawTiming.completedAt === 'number' ? rawTiming.completedAt : null,
      queueMs: num(rawTiming.queueMs ?? rawTiming.queue_ms, 0),
      requestMs: num(rawTiming.requestMs ?? rawTiming.request_ms, 0),
      ttfbMs: typeof ttfbVal === 'number' && Number.isFinite(ttfbVal) ? ttfbVal : null,
      downloadMs: num(rawTiming.downloadMs ?? rawTiming.download_ms, 0),
      totalMs: num(rawTiming.totalMs ?? rawTiming.total_ms, 0),
    },
    ...(typeof (r.httpStatus ?? r.http_status) === 'number'
      ? { httpStatus: Number(r.httpStatus ?? r.http_status) }
      : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {}),
    ...(typeof r.advice === 'string' ? { advice: r.advice } : {}),
    ...(typeof r.systemPromptApplied === 'string' ? { systemPromptApplied: r.systemPromptApplied } : {}),
    ...(typeof r.audioDataUrl === 'string' ? { audioDataUrl: r.audioDataUrl } : {}),
    ...(typeof r.endpointUrl === 'string' ? { endpointUrl: r.endpointUrl } : {}),
  };
}

const DEFAULT_IMPORTED_SYSTEM_PROMPT: SystemPromptConfig = {
  enabled: false,
  content: '',
  personaId: null,
  targetMode: 'all',
  targetModelIds: [],
};

const DEFAULT_IMPORTED_EXECUTION: ExecutionConfig = {
  mode: 'parallel',
  concurrency: 3,
  timeoutSec: 300,
  stream: true,
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  randomizeOrder: false,
  endpointType: 'chat-completions',
};

/**
 * Parses exported benchmark JSON files (Web wrapper `{ run }`, direct `BenchmarkRunRecord`,
 * Rust TUI `benchmark-<ts>.json`, or `history.json` arrays) into a normalized BenchmarkRunRecord.
 */
export function parseBenchmarkResultsJson(rawJson: string): BenchmarkRunRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid JSON file. Expected a BenchForge benchmark results JSON export.');
  }

  let candidate: unknown = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error('JSON array contains no benchmark runs.');
    }
    candidate = parsed[0];
  } else if (parsed && typeof parsed === 'object' && 'run' in parsed) {
    candidate = (parsed as { run: unknown }).run;
  }

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Unrecognized benchmark JSON schema: missing run object.');
  }

  const obj = candidate as Record<string, unknown>;
  if (!Array.isArray(obj.results)) {
    throw new Error('Unrecognized benchmark JSON schema: missing "results" array.');
  }

  const rawCreated = obj.createdAt ?? obj.created_at;
  const createdAt =
    typeof rawCreated === 'number' && Number.isFinite(rawCreated)
      ? rawCreated
      : typeof rawCreated === 'string' && !Number.isNaN(Date.parse(rawCreated))
      ? Date.parse(rawCreated)
      : Date.now();

  const results = obj.results.map((item, idx) => normalizeImportedResult(item, idx));
  const sysRaw = (obj.systemPrompt && typeof obj.systemPrompt === 'object'
    ? obj.systemPrompt
    : {}) as Partial<SystemPromptConfig>;
  const execRaw = (obj.executionConfig && typeof obj.executionConfig === 'object'
    ? obj.executionConfig
    : {}) as Partial<ExecutionConfig>;

  return {
    id: String(obj.id ?? `imported-${Date.now()}`),
    title: String(obj.title ?? 'Imported Benchmark'),
    createdAt,
    prompt: typeof obj.prompt === 'string' ? obj.prompt : '',
    ...(typeof obj.suiteName === 'string' ? { suiteName: obj.suiteName } : {}),
    systemPrompt: {
      ...DEFAULT_IMPORTED_SYSTEM_PROMPT,
      ...sysRaw,
      targetModelIds: Array.isArray(sysRaw.targetModelIds) ? sysRaw.targetModelIds : [],
    },
    executionConfig: {
      ...DEFAULT_IMPORTED_EXECUTION,
      ...execRaw,
    },
    results,
  };
}

export function triggerFileDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

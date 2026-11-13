import type { BenchmarkRunRecord, ModelRunResult } from '../types/benchmark';

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

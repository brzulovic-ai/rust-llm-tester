import type { BenchmarkRunRecord } from '../types/benchmark';

export interface SharePayload {
  v: 1;
  title: string;
  prompt: string;
  suiteName?: string;
  systemPrompt: BenchmarkRunRecord['systemPrompt'];
  executionConfig: BenchmarkRunRecord['executionConfig'];
  results: Array<{
    targetId: string;
    modelName: string;
    providerName: string;
    providerKind: BenchmarkRunRecord['results'][number]['providerKind'];
    status: BenchmarkRunRecord['results'][number]['status'];
    output: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    tokensPerSec: number;
    timing: BenchmarkRunRecord['results'][number]['timing'];
  }>;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeShareState(run: Omit<BenchmarkRunRecord, 'id' | 'createdAt'>): string {
  const successfulResults = run.results.filter((r) => r.status === 'completed');
  const payload: SharePayload = {
    v: 1,
    title: run.title,
    prompt: run.prompt,
    suiteName: run.suiteName,
    systemPrompt: run.systemPrompt,
    executionConfig: run.executionConfig,
    results: successfulResults.map((r) => ({
      targetId: r.targetId,
      modelName: r.modelName,
      providerName: r.providerName,
      providerKind: r.providerKind,
      status: r.status,
      output: r.output,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      tokensPerSec: r.tokensPerSec,
      timing: r.timing,
    })),
  };

  const json = JSON.stringify(payload);
  const encoded = new TextEncoder().encode(json);
  return toBase64Url(encoded);
}

export function decodeShareState(hashString: string): SharePayload | null {
  try {
    const cleaned = hashString.replace(/^#/, '');
    const match = cleaned.match(/share=([A-Za-z0-9_-]+)/);
    if (!match || !match[1]) return null;
    const bytes = fromBase64Url(match[1]);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as SharePayload;
    if (parsed && parsed.v === 1 && typeof parsed.prompt === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildShareUrl(currentHref: string, run: Omit<BenchmarkRunRecord, 'id' | 'createdAt'>): string {
  const token = encodeShareState(run);
  const base = currentHref.split('#')[0];
  return `${base}#share=${token}`;
}

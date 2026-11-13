import type { TimingBreakdown } from '../types/benchmark';

export interface ParsedSseEvent {
  contentDelta: string;
  done: boolean;
  error?: string;
  advice?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Estimates token count when upstream provider omits usage metadata.
 * Uses ~3.8 characters per token heuristic with whitespace boundary awareness.
 */
export function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 3.8));
}

/**
 * Parses an OpenAI-compatible SSE chunk block (one or more `data: ...` lines).
 */
export function parseSseLines(rawChunk: string, remainderBuffer: string): {
  events: ParsedSseEvent[];
  nextBuffer: string;
} {
  const combined = remainderBuffer + rawChunk;
  const lines = combined.split(/\r?\n/);
  const nextBuffer = lines.pop() ?? '';
  const events: ParsedSseEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (!trimmed.startsWith('data:')) continue;

    const payloadStr = trimmed.slice(5).trim();
    if (!payloadStr) continue;

    if (payloadStr === '[DONE]') {
      events.push({ contentDelta: '', done: true });
      continue;
    }

    try {
      const parsed = JSON.parse(payloadStr) as {
        error?: { message?: string; advice?: string } | string;
        choices?: Array<{
          delta?: { content?: string; reasoning_content?: string };
          message?: { content?: string };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      if (parsed.error) {
        const msg =
          typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error.message || 'Upstream stream error';
        const advice = typeof parsed.error === 'object' ? parsed.error.advice : undefined;
        events.push({ contentDelta: '', done: true, error: msg, advice });
        continue;
      }

      const choice = parsed.choices?.[0];
      const deltaText =
        choice?.delta?.content ??
        choice?.delta?.reasoning_content ??
        choice?.message?.content ??
        '';

      const usage = parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          }
        : undefined;

      events.push({
        contentDelta: deltaText,
        done: false,
        usage,
      });
    } catch {
      // Ignore malformed partial JSON lines
    }
  }

  return { events, nextBuffer };
}

export function createInitialTiming(enqueuedAt: number): TimingBreakdown {
  return {
    enqueuedAt,
    startedAt: enqueuedAt,
    headersAt: null,
    firstTokenAt: null,
    completedAt: null,
    queueMs: 0,
    requestMs: 0,
    ttfbMs: null,
    downloadMs: 0,
    totalMs: 0,
  };
}

export function computeTimingMetrics(timing: TimingBreakdown, now: number): TimingBreakdown {
  const startedAt = timing.startedAt || timing.enqueuedAt;
  const queueMs = Math.max(0, startedAt - timing.enqueuedAt);
  const requestMs = timing.headersAt ? Math.max(0, timing.headersAt - startedAt) : Math.max(0, now - startedAt);
  const ttfbMs = timing.firstTokenAt !== null ? Math.max(0, timing.firstTokenAt - startedAt) : null;
  const endRef = timing.completedAt ?? now;
  const downloadMs =
    timing.firstTokenAt !== null ? Math.max(0, endRef - timing.firstTokenAt) : 0;
  const totalMs = Math.max(0, endRef - timing.enqueuedAt);

  return {
    ...timing,
    queueMs,
    requestMs,
    ttfbMs,
    downloadMs,
    totalMs,
  };
}

export function computeTokensPerSecond(completionTokens: number, timing: TimingBreakdown): number {
  if (completionTokens <= 0) return 0;
  const genMs = timing.downloadMs > 10 ? timing.downloadMs : timing.totalMs - timing.queueMs;
  if (genMs <= 0) return 0;
  return Number(((completionTokens / genMs) * 1000).toFixed(1));
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Extracts runnable HTML snippet from markdown fenced code blocks or raw HTML text.
 */
export function extractHtmlSnippet(content: string): string | null {
  if (!content.trim()) return null;
  const fencedMatch = content.match(/```html\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]?.trim()) {
    return fencedMatch[1].trim();
  }
  const genericDocMatch = content.match(/(<!doctype\s+html[\s\S]*?<\/html>)/i);
  if (genericDocMatch && genericDocMatch[1]) {
    return genericDocMatch[1].trim();
  }
  const htmlTagMatch = content.match(/(<html[\s\S]*?<\/html>)/i);
  if (htmlTagMatch && htmlTagMatch[1]) {
    return htmlTagMatch[1].trim();
  }
  return null;
}

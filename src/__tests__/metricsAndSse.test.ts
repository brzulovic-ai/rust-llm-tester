import { describe, expect, it } from 'vitest';
import {
  computeTimingMetrics,
  computeTokensPerSecond,
  createInitialTiming,
  estimateTokenCount,
  extractHtmlSnippet,
  formatMs,
  parseSseLines,
} from '../utils/metrics';

describe('Metrics, SSE Parser & HTML Extractor', () => {
  it('estimates zero tokens for empty or whitespace text', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('   \n  ')).toBe(0);
  });

  it('estimates positive token count proportionally for prose', () => {
    const tokens = estimateTokenCount('Hello world this is a test prompt.');
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it('parses OpenAI-compatible SSE delta chunks and buffers partial lines', () => {
    const chunk1 = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con';
    const res1 = parseSseLines(chunk1, '');
    expect(res1.events).toHaveLength(1);
    expect(res1.events[0].contentDelta).toBe('Hel');
    expect(res1.nextBuffer).toContain('{"choices"');

    const chunk2 = 'tent":"lo"}}]}\n\ndata: [DONE]\n\n';
    const res2 = parseSseLines(chunk2, res1.nextBuffer);
    expect(res2.events).toHaveLength(2);
    expect(res2.events[0].contentDelta).toBe('lo');
    expect(res2.events[1].done).toBe(true);
  });

  it('parses SSE usage metadata chunks', () => {
    const chunk =
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":14,"completion_tokens":42,"total_tokens":56}}\n\n';
    const { events } = parseSseLines(chunk, '');
    expect(events[0].usage).toEqual({
      promptTokens: 14,
      completionTokens: 42,
      totalTokens: 56,
    });
  });

  it('parses SSE error events with troubleshooting advice', () => {
    const chunk =
      'data: {"error":{"message":"Upstream timeout","advice":"Increase timeout"}}\n\n';
    const { events } = parseSseLines(chunk, '');
    expect(events[0].done).toBe(true);
    expect(events[0].error).toBe('Upstream timeout');
    expect(events[0].advice).toBe('Increase timeout');
  });

  it('ignores SSE keepalive comments', () => {
    const chunk = ': keepalive\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    const { events } = parseSseLines(chunk, '');
    expect(events).toHaveLength(1);
    expect(events[0].contentDelta).toBe('ok');
  });

  it('computes queue, request, ttfb, download, and total durations accurately', () => {
    const base = createInitialTiming(1000);
    const updated = computeTimingMetrics(
      {
        ...base,
        startedAt: 1050,
        headersAt: 1150,
        firstTokenAt: 1300,
        completedAt: 2300,
      },
      2300
    );
    expect(updated.queueMs).toBe(50);
    expect(updated.requestMs).toBe(100);
    expect(updated.ttfbMs).toBe(250);
    expect(updated.downloadMs).toBe(1000);
    expect(updated.totalMs).toBe(1300);
  });

  it('handles null TTFB when headers arrived without tokens yet', () => {
    const base = createInitialTiming(100);
    const updated = computeTimingMetrics({ ...base, startedAt: 110, headersAt: 160 }, 200);
    expect(updated.ttfbMs).toBeNull();
    expect(updated.downloadMs).toBe(0);
    expect(updated.totalMs).toBe(100);
  });

  it('computes tokens per second accurately', () => {
    const timing = {
      ...createInitialTiming(0),
      downloadMs: 2000,
      totalMs: 2500,
    };
    expect(computeTokensPerSecond(100, timing)).toBe(50);
    expect(computeTokensPerSecond(0, timing)).toBe(0);
  });

  it('formats milliseconds and seconds cleanly', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(342.4)).toBe('342 ms');
    expect(formatMs(1450)).toBe('1.45 s');
  });

  it('extracts fenced html code blocks', () => {
    const md = 'Here is your game:\n```html\n<!doctype html><html><body>Hi</body></html>\n```';
    expect(extractHtmlSnippet(md)).toBe('<!doctype html><html><body>Hi</body></html>');
  });

  it('extracts raw doctype html documents when unfenced', () => {
    const raw = 'Intro\n<!DOCTYPE html><html><body><canvas></canvas></body></html>\nOutro';
    expect(extractHtmlSnippet(raw)).toContain('<canvas></canvas>');
  });

  it('returns null when no HTML document is present', () => {
    expect(extractHtmlSnippet('Just plain markdown prose.')).toBeNull();
    expect(extractHtmlSnippet('')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { computeTokenDiff, tokenizeForDiff } from '../utils/diffEngine';
import { buildCsvExport, buildJsonExport } from '../utils/exportUtils';
import { parseMarkdownBlocks } from '../utils/markdown';
import { buildShareUrl, decodeShareState, encodeShareState } from '../utils/shareUtils';
import type { BenchmarkRunRecord } from '../types/benchmark';
import { createInitialTiming } from '../utils/metrics';

const sampleRecord: BenchmarkRunRecord = {
  id: 'run-1',
  title: 'Test Run',
  createdAt: 1700000000000,
  prompt: 'Explain Raft, "lightly"\nand cleanly.',
  suiteName: 'Classic Benchmarks',
  systemPrompt: {
    enabled: true,
    content: 'Be concise.',
    personaId: 'concise-expert',
    targetMode: 'all',
    targetModelIds: [],
  },
  executionConfig: {
    mode: 'parallel',
    concurrency: 3,
    timeoutSec: 300,
    stream: true,
    temperature: 0.7,
    maxTokens: 1024,
    topP: 1,
  },
  results: [
    {
      targetId: 't1',
      modelName: 'gemini-4-hydrogen',
      providerName: 'Gemini',
      providerKind: 'gemini-builtin',
      status: 'completed',
      output: 'Raft uses Pre-Vote.',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      tokensPerSec: 45.2,
      timing: {
        ...createInitialTiming(100),
        ttfbMs: 120,
        downloadMs: 250,
        totalMs: 370,
      },
    },
    {
      targetId: 't2',
      modelName: 'llama3.2',
      providerName: 'Ollama',
      providerKind: 'ollama',
      status: 'error',
      output: '',
      promptTokens: 10,
      completionTokens: 0,
      totalTokens: 10,
      tokensPerSec: 0,
      error: 'Connection refused',
      timing: createInitialTiming(100),
    },
  ],
};

describe('Diff Engine, Share Links, Export & Markdown', () => {
  it('tokenizes text while preserving whitespace runs', () => {
    expect(tokenizeForDiff('alpha  beta\ngamma')).toEqual(['alpha', '  ', 'beta', '\n', 'gamma']);
    expect(tokenizeForDiff('')).toEqual([]);
  });

  it('computes 100% similarity for identical outputs', () => {
    const res = computeTokenDiff('hello world test', 'hello world test');
    expect(res.stats.similarityPct).toBe(100);
    expect(res.stats.insertions).toBe(0);
    expect(res.stats.deletions).toBe(0);
  });

  it('identifies token insertions and deletions accurately', () => {
    const res = computeTokenDiff('the quick brown fox', 'the fast brown dog');
    expect(res.stats.deletions).toBe(2);
    expect(res.stats.insertions).toBe(2);
    expect(res.stats.unchanged).toBe(2);
    expect(res.segments.some((s) => s.type === 'delete' && s.value.includes('quick'))).toBe(true);
    expect(res.segments.some((s) => s.type === 'insert' && s.value.includes('fast'))).toBe(true);
  });

  it('handles empty comparison gracefully', () => {
    const res = computeTokenDiff('', '');
    expect(res.segments).toEqual([]);
    expect(res.stats.similarityPct).toBe(100);
  });

  it('encodes and decodes share state including Unicode characters', () => {
    const token = encodeShareState({
      title: 'Unicode — Benchmark 🚀',
      prompt: 'Analyze π ≈ 3.14159',
      systemPrompt: sampleRecord.systemPrompt,
      executionConfig: sampleRecord.executionConfig,
      results: sampleRecord.results,
    });
    const decoded = decodeShareState(`#share=${token}`);
    expect(decoded).not.toBeNull();
    expect(decoded?.title).toBe('Unicode — Benchmark 🚀');
    expect(decoded?.prompt).toBe('Analyze π ≈ 3.14159');
    // Only completed results are shared
    expect(decoded?.results).toHaveLength(1);
    expect(decoded?.results[0].modelName).toBe('gemini-4-hydrogen');
  });

  it('builds a valid shareable URL replacing existing hash', () => {
    const url = buildShareUrl('https://workbench.local/app#old', {
      title: sampleRecord.title,
      prompt: sampleRecord.prompt,
      systemPrompt: sampleRecord.systemPrompt,
      executionConfig: sampleRecord.executionConfig,
      results: sampleRecord.results,
    });
    expect(url.startsWith('https://workbench.local/app#share=')).toBe(true);
  });

  it('returns null on invalid share hashes', () => {
    expect(decodeShareState('')).toBeNull();
    expect(decodeShareState('#share=not-valid-base64!!!')).toBeNull();
  });

  it('generates RFC-4180 escaped CSV exports', () => {
    const csv = buildCsvExport(sampleRecord.results, sampleRecord.prompt);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Model,Provider,Status');
    expect(csv).toContain('"Explain Raft, ""lightly""');
    expect(csv).toContain('gemini-4-hydrogen');
  });

  it('generates valid JSON export bundles', () => {
    const raw = buildJsonExport(sampleRecord);
    const parsed = JSON.parse(raw);
    expect(parsed.workbench).toBe('LLM Multi-Tester & Benchmark Workbench');
    expect(parsed.run.id).toBe('run-1');
    expect(parsed.run.results).toHaveLength(2);
  });

  it('parses markdown headings, fenced code, lists, tables, and blockquotes', () => {
    const md = [
      '# Architecture',
      '',
      '> Key invariant',
      '',
      '- Item A',
      '- Item B',
      '',
      '| Model | Speed |',
      '| --- | --- |',
      '| H2 | 90 t/s |',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');

    const blocks = parseMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'blockquote',
      'list',
      'table',
      'code',
    ]);
    expect(blocks[3]).toEqual({
      type: 'table',
      headers: ['Model', 'Speed'],
      rows: [['H2', '90 t/s']],
    });
  });
});

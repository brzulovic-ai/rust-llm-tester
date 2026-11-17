import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PROMPT_SUITES, SYSTEM_PERSONAS } from '../data/promptSuites';
import { resolveSystemPromptForTarget, runExecutionPool } from '../utils/executionEngine';
import {
  clearHistory,
  deleteRunFromHistory,
  loadHistory,
  MAX_HISTORY_RUNS,
  saveRunToHistory,
} from '../utils/historyStore';
import type {
  BenchmarkRunRecord,
  ExecutionConfig,
  ProviderEndpoint,
  SystemPromptConfig,
  TargetModel,
} from '../types/benchmark';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('Execution Engine, Suites & History Store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes all 18 Systems & Reasoning prompts, 4 HTML Games, and 5 Classic Benchmarks (with Ping)', () => {
    const sr = PROMPT_SUITES.filter((p) => p.suite === 'systems-reasoning');
    const hg = PROMPT_SUITES.filter((p) => p.suite === 'html-games');
    const cb = PROMPT_SUITES.filter((p) => p.suite === 'classic-benchmarks');
    expect(sr).toHaveLength(18);
    expect(hg).toHaveLength(4);
    expect(cb).toHaveLength(5);
    expect(SYSTEM_PERSONAS.map((p) => p.name)).toEqual([
      'Concise Expert',
      'Deep Analyst',
      'Code Architect',
      'Daily Assistant',
      'Writing & Comms',
      'Quick Summarizer',
      'DevOps / SRE',
      'Incident Triage',
      'SecOps & Containers',
    ]);
  });

  it('resolves system prompt targeting for all models vs specific models', () => {
    const t1: TargetModel = {
      id: 't1',
      providerId: 'p1',
      providerName: 'P1',
      providerKind: 'openai',
      modelName: 'm1',
      enabled: true,
    };
    const t2: TargetModel = { ...t1, id: 't2', modelName: 'm2' };

    const allCfg: SystemPromptConfig = {
      enabled: true,
      content: 'Global rule',
      personaId: null,
      targetMode: 'all',
      targetModelIds: [],
    };
    expect(resolveSystemPromptForTarget(t1, allCfg)).toBe('Global rule');
    expect(resolveSystemPromptForTarget(t2, allCfg)).toBe('Global rule');

    const specificCfg: SystemPromptConfig = {
      ...allCfg,
      targetMode: 'specific',
      targetModelIds: ['t2'],
    };
    expect(resolveSystemPromptForTarget(t1, specificCfg)).toBeUndefined();
    expect(resolveSystemPromptForTarget(t2, specificCfg)).toBe('Global rule');

    const disabledCfg: SystemPromptConfig = { ...allCfg, enabled: false };
    expect(resolveSystemPromptForTarget(t1, disabledCfg)).toBeUndefined();
  });

  it('executes parallel worker pool and updates results via non-streaming JSON response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [{ message: { content: 'Answer from model' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const providers: ProviderEndpoint[] = [
      {
        id: 'p1',
        name: 'Test Provider',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        customHeaders: {},
        directBrowser: false,
        models: ['m1', 'm2'],
      },
    ];
    const targets: TargetModel[] = [
      {
        id: 't1',
        providerId: 'p1',
        providerName: 'Test Provider',
        providerKind: 'openai',
        modelName: 'm1',
        enabled: true,
      },
      {
        id: 't2',
        providerId: 'p1',
        providerName: 'Test Provider',
        providerKind: 'openai',
        modelName: 'm2',
        enabled: true,
      },
    ];
    const execCfg: ExecutionConfig = {
      mode: 'parallel',
      concurrency: 2,
      timeoutSec: 30,
      stream: false,
      temperature: 0.5,
      maxTokens: 512,
      topP: 1,
    };

    const updates: string[] = [];
    const results = await runExecutionPool({
      targets,
      providers,
      prompt: 'Ping',
      systemPrompt: {
        enabled: false,
        content: '',
        personaId: null,
        targetMode: 'all',
        targetModelIds: [],
      },
      executionConfig: execCfg,
      signal: new AbortController().signal,
      onResultUpdate: (id, r) => updates.push(`${id}:${r.status}`),
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(results[0].output).toBe('Answer from model');
    expect(updates.some((u) => u === 't1:completed')).toBe(true);
  });

  it('captures HTTP error responses with troubleshooting advice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          error: 'Invalid API key',
          advice: 'Verify your API key.',
        }),
      })
    );

    const providers: ProviderEndpoint[] = [
      {
        id: 'p1',
        name: 'Groq',
        kind: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'bad',
        customHeaders: {},
        directBrowser: false,
        models: ['llama'],
      },
    ];
    const targets: TargetModel[] = [
      {
        id: 't1',
        providerId: 'p1',
        providerName: 'Groq',
        providerKind: 'groq',
        modelName: 'llama',
        enabled: true,
      },
    ];

    const results = await runExecutionPool({
      targets,
      providers,
      prompt: 'Hello',
      systemPrompt: {
        enabled: false,
        content: '',
        personaId: null,
        targetMode: 'all',
        targetModelIds: [],
      },
      executionConfig: {
        mode: 'sequential',
        concurrency: 1,
        timeoutSec: 30,
        stream: false,
        temperature: 0.7,
        maxTokens: 256,
        topP: 1,
      },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(results[0].status).toBe('error');
    expect(results[0].httpStatus).toBe(401);
    expect(results[0].advice).toContain('Verify your API key');
  });

  it('caps local history storage to the most recent 50 runs and supports delete/clear', () => {
    const storage = createMemoryStorage();
    for (let i = 1; i <= 55; i++) {
      const rec: BenchmarkRunRecord = {
        id: `run-${i}`,
        title: `Run ${i}`,
        createdAt: i * 1000,
        prompt: `Prompt ${i}`,
        systemPrompt: {
          enabled: false,
          content: '',
          personaId: null,
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
        results: [],
      };
      saveRunToHistory(rec, storage);
    }

    const loaded = loadHistory(storage);
    expect(loaded).toHaveLength(MAX_HISTORY_RUNS);
    expect(loaded[0].id).toBe('run-55');
    expect(loaded[49].id).toBe('run-6');

    const afterDel = deleteRunFromHistory('run-55', storage);
    expect(afterDel[0].id).toBe('run-54');

    clearHistory(storage);
    expect(loadHistory(storage)).toEqual([]);
  });
});

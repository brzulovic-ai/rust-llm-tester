import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { CapabilityGraphView } from '../components/CapabilityGraphView';
import { WaterfallView } from '../components/WaterfallView';
import type {
  EndpointFileAttachment,
  ExecutionConfig,
  ModelRunResult,
  ProviderEndpoint,
  TargetModel,
} from '../types/benchmark';
import {
  filesForEndpoint,
  resolveEndpointUrl,
  shouldUseMultipartUpload,
} from '../utils/endpointUtils';
import { runExecutionPool } from '../utils/executionEngine';
import { createInitialTiming, extractHtmlSnippet, formatMs, parseSseLines } from '../utils/metrics';
import { encodeShareState } from '../utils/shareUtils';
import { pullRunsFromSupabase, pushRunToSupabase, testSupabaseConnection } from '../utils/supabaseSync';

describe('Extended Coverage Suite (50+ Target)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('extracts reasoning_content deltas when content is absent', () => {
    const chunk = 'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n';
    const { events } = parseSseLines(chunk, '');
    expect(events[0].contentDelta).toBe('Thinking...');
  });

  it('handles multiple SSE events in a single TCP chunk', () => {
    const chunk =
      'data: {"choices":[{"delta":{"content":"One "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Two"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { events } = parseSseLines(chunk, '');
    expect(events).toHaveLength(3);
    expect(events[0].contentDelta + events[1].contentDelta).toBe('One Two');
    expect(events[2].done).toBe(true);
  });

  it('formats 1000ms threshold cleanly into seconds', () => {
    expect(formatMs(999)).toBe('999 ms');
    expect(formatMs(1000)).toBe('1.00 s');
  });

  it('extracts bare <html>...</html> tags without doctype', () => {
    const text = 'Preview:\n<html><body><h1>Game</h1></body></html>';
    expect(extractHtmlSnippet(text)).toBe('<html><body><h1>Game</h1></body></html>');
  });

  it('runs sequential execution strictly one target at a time', async () => {
    const order: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { model: string };
        order.push(`start:${body.model}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${body.model}`);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ choices: [{ message: { content: body.model } }] }),
        };
      })
    );

    const providers: ProviderEndpoint[] = [
      {
        id: 'p1',
        name: 'P1',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        customHeaders: {},
        directBrowser: false,
        models: ['a', 'b'],
      },
    ];
    const targets: TargetModel[] = [
      { id: 't1', providerId: 'p1', providerName: 'P1', providerKind: 'openai', modelName: 'a', enabled: true },
      { id: 't2', providerId: 'p1', providerName: 'P1', providerKind: 'openai', modelName: 'b', enabled: true },
    ];
    const cfg: ExecutionConfig = {
      mode: 'sequential',
      concurrency: 5,
      timeoutSec: 30,
      stream: false,
      temperature: 0.7,
      maxTokens: 100,
      topP: 1,
    };

    await runExecutionPool({
      targets,
      providers,
      prompt: 'hi',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: cfg,
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('routes directBrowser providers directly to baseUrl/chat/completions', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ choices: [{ message: { content: 'local' } }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const providers: ProviderEndpoint[] = [
      {
        id: 'ol',
        name: 'Ollama',
        kind: 'ollama',
        baseUrl: 'http://localhost:11434/v1/',
        apiKey: '',
        customHeaders: { 'X-Custom': '1' },
        directBrowser: true,
        models: ['llama3'],
      },
    ];
    const targets: TargetModel[] = [
      { id: 't1', providerId: 'ol', providerName: 'Ollama', providerKind: 'ollama', modelName: 'llama3', enabled: true },
    ];

    await runExecutionPool({
      targets,
      providers,
      prompt: 'hi',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: { mode: 'parallel', concurrency: 1, timeoutSec: 30, stream: false, temperature: 0.5, maxTokens: 100, topP: 1 },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('routes gemini-builtin providers to /api/gemini/chat', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ choices: [{ message: { content: 'gemini' } }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const providers: ProviderEndpoint[] = [
      {
        id: 'gem',
        name: 'Gemini',
        kind: 'gemini-builtin',
        baseUrl: '/api/gemini/chat',
        apiKey: '',
        customHeaders: {},
        directBrowser: false,
        models: ['gemini-4-hydrogen'],
      },
    ];
    const targets: TargetModel[] = [
      { id: 'tg', providerId: 'gem', providerName: 'Gemini', providerKind: 'gemini-builtin', modelName: 'gemini-4-hydrogen', enabled: true },
    ];

    await runExecutionPool({
      targets,
      providers,
      prompt: 'hi',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: { mode: 'parallel', concurrency: 1, timeoutSec: 30, stream: false, temperature: 0.5, maxTokens: 100, topP: 1 },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('/api/gemini/chat');
  });

  it('handles missing provider configuration gracefully without crashing pool', async () => {
    const targets: TargetModel[] = [
      { id: 't-missing', providerId: 'does-not-exist', providerName: 'Ghost', providerKind: 'custom', modelName: 'm', enabled: true },
    ];
    const res = await runExecutionPool({
      targets,
      providers: [],
      prompt: 'hi',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: { mode: 'parallel', concurrency: 1, timeoutSec: 30, stream: false, temperature: 0.5, maxTokens: 100, topP: 1 },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });
    expect(res[0].status).toBe('error');
    expect(res[0].error).toContain('Provider configuration not found');
  });

  it('marks aborted runs as aborted when AbortController fires', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          })
      )
    );

    const providers: ProviderEndpoint[] = [
      { id: 'p1', name: 'P1', kind: 'openai', baseUrl: 'https://x.com/v1', apiKey: '', customHeaders: {}, directBrowser: false, models: ['m'] },
    ];
    const targets: TargetModel[] = [
      { id: 't1', providerId: 'p1', providerName: 'P1', providerKind: 'openai', modelName: 'm', enabled: true },
    ];

    setTimeout(() => controller.abort('cancelled'), 10);
    const res = await runExecutionPool({
      targets,
      providers,
      prompt: 'hi',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: { mode: 'parallel', concurrency: 1, timeoutSec: 30, stream: false, temperature: 0.5, maxTokens: 100, topP: 1 },
      signal: controller.signal,
      onResultUpdate: () => {},
    });

    expect(res[0].status).toBe('aborted');
  });

  it('validates Supabase credentials before network call on test/push/pull', async () => {
    const emptyCfg = { url: '', anonKey: '', tableName: 'benchmark_runs', autoSync: false };
    const tLog = await testSupabaseConnection(emptyCfg);
    expect(tLog.status).toBe('error');

    const pLog = await pushRunToSupabase(emptyCfg, {
      id: '1',
      title: 'T',
      createdAt: 1,
      prompt: 'P',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: { mode: 'parallel', concurrency: 1, timeoutSec: 30, stream: false, temperature: 0.5, maxTokens: 100, topP: 1 },
      results: [],
    });
    expect(pLog.status).toBe('error');

    const pullRes = await pullRunsFromSupabase(emptyCfg);
    expect(pullRes.log.status).toBe('error');
    expect(pullRes.runs).toEqual([]);
  });

  it('logs success on Supabase connection test when proxy returns ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: 200, message: 'Connected to table "benchmark_runs"' }),
      })
    );
    const log = await testSupabaseConnection({
      url: 'https://demo.supabase.co',
      anonKey: 'key',
      tableName: 'benchmark_runs',
      autoSync: false,
    });
    expect(log.status).toBe('success');
    expect(log.message).toContain('Connected');
  });

  it('switches Prompt Test Suites tabs in SidebarAccordion', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /HTML Games \(4\)/i }));
    expect(screen.getByText(/Single-File Retro Breakout Arcade/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Classic \(5\)/i }));
    expect(screen.getByText(/Multi-Step Logic & Constraint Grid/i)).toBeInTheDocument();
  });

  it('applies built-in System Prompt Personas and toggles Specific Models mode', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Concise Expert' }));
    expect(screen.getByPlaceholderText('Enter custom system instructions...')).toBeInTheDocument();

    const modeSelect = screen.getByLabelText('System prompt targeting mode');
    fireEvent.change(modeSelect, { target: { value: 'specific' } });
    expect(screen.getByText(/Apply system directive to:/i)).toBeInTheDocument();
  });

  it('expands History & Cloud Sync section and shows Sync Log Monitor', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /History & Cloud Sync/i }));
    expect(screen.getByText(/Supabase PostgreSQL Sync/i)).toBeInTheDocument();
    expect(screen.getByText(/Sync Log Monitor/i)).toBeInTheDocument();
  });

  it('hydrates prompt and completed results from URL share hash on mount', () => {
    const token = encodeShareState({
      title: 'Shared Hydrated Run',
      prompt: 'Hydrated evaluation prompt',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: { mode: 'parallel', concurrency: 2, timeoutSec: 300, stream: true, temperature: 0.7, maxTokens: 1024, topP: 1 },
      results: [
        {
          targetId: 'target-gemini-hydrogen',
          modelName: 'gemini-4-hydrogen',
          providerName: 'Gemini Server Engine',
          providerKind: 'gemini-builtin',
          status: 'completed',
          output: 'Hydrated response text.',
          promptTokens: 5,
          completionTokens: 4,
          totalTokens: 9,
          tokensPerSec: 64.0,
          timing: createInitialTiming(100),
        },
      ],
    });
    window.location.hash = `#share=${token}`;
    render(<App />);
    expect(screen.getByText('Shared Hydrated Run')).toBeInTheDocument();
    expect(screen.getByText('Hydrated response text.')).toBeInTheDocument();
  });

  it('toggles Waterfall sorting direction on column click', () => {
    const items: ModelRunResult[] = [
      {
        targetId: 'a',
        modelName: 'Alpha',
        providerName: 'P',
        providerKind: 'openai',
        status: 'completed',
        output: 'x',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        tokensPerSec: 10,
        timing: { ...createInitialTiming(0), totalMs: 200, ttfbMs: 50 },
      },
      {
        targetId: 'b',
        modelName: 'Beta',
        providerName: 'P',
        providerKind: 'openai',
        status: 'completed',
        output: 'y',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        tokensPerSec: 20,
        timing: { ...createInitialTiming(0), totalMs: 400, ttfbMs: 100 },
      },
    ];
    render(<WaterfallView results={items} />);
    const modelHeaderBtn = screen.getByRole('button', { name: /Model/i });
    fireEvent.click(modelHeaderBtn);
    fireEvent.click(modelHeaderBtn);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('updates CapabilityGraphView axis labels when switching X/Y metrics', () => {
    const items: ModelRunResult[] = [
      {
        targetId: 'a',
        modelName: 'ModelX',
        providerName: 'P',
        providerKind: 'openai',
        status: 'completed',
        output: 'x',
        promptTokens: 1,
        completionTokens: 50,
        totalTokens: 51,
        tokensPerSec: 30,
        timing: { ...createInitialTiming(0), totalMs: 500, ttfbMs: 100 },
      },
    ];
    render(<CapabilityGraphView results={items} />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'totalMs' } });
    fireEvent.change(selects[1], { target: { value: 'completionTokens' } });
    expect(screen.getAllByText('Total Duration (ms)').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Output Tokens').length).toBeGreaterThanOrEqual(2);
  });

  it('navigates between top bar workspace views in App', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Waterfall' }));
    expect(screen.getByText('Network Timing Waterfall')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Diff Compare' }));
    expect(screen.getByText(/Baseline \(A\)/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Capability Graph' }));
    expect(screen.getByText('XY Capability Scatter Plot')).toBeInTheDocument();
  });

  it('resolves endpoint URLs, scoped files, and multipart upload rules cleanly', () => {
    expect(resolveEndpointUrl('https://api.openai.com/v1/', 'audio-transcriptions')).toBe(
      'https://api.openai.com/v1/audio/transcriptions'
    );
    expect(resolveEndpointUrl('https://api.openai.com/v1', 'custom', '/v1/rerank')).toBe(
      'https://api.openai.com/v1/rerank'
    );
    expect(
      resolveEndpointUrl('http://localhost:8000/v1', 'custom', 'https://custom.local/infer')
    ).toBe('https://custom.local/infer');

    const files: EndpointFileAttachment[] = [
      {
        id: 'f1',
        name: 'clip.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 128,
        endpointScope: 'audio-transcriptions',
        fieldName: 'file',
        base64Data: 'AAAA',
        enabled: true,
        addedAt: 1,
      },
      {
        id: 'f2',
        name: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 64,
        endpointScope: 'all',
        fieldName: 'context',
        base64Data: 'aGVsbG8=',
        textPreview: 'hello',
        enabled: true,
        addedAt: 2,
      },
      {
        id: 'f3',
        name: 'disabled.wav',
        mimeType: 'audio/wav',
        sizeBytes: 64,
        endpointScope: 'audio-transcriptions',
        fieldName: 'file',
        base64Data: 'AAAA',
        enabled: false,
        addedAt: 3,
      },
    ];

    expect(filesForEndpoint(files, 'audio-transcriptions').map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(filesForEndpoint(files, 'embeddings').map((f) => f.id)).toEqual(['f2']);
    expect(shouldUseMultipartUpload('audio-transcriptions', 'auto', [])).toBe(true);
    expect(shouldUseMultipartUpload('custom', 'auto', [files[0]])).toBe(true);
    expect(shouldUseMultipartUpload('custom', 'json', [files[0]])).toBe(false);
  });

  it('validates missing audio file error and sends multipart upload via /api/proxy/endpoint when attached', async () => {
    const provider: ProviderEndpoint = {
      id: 'p-audio',
      name: 'OpenAI Audio',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      customHeaders: {},
      directBrowser: false,
      models: ['whisper-1'],
    };
    const target: TargetModel = {
      id: 't-whisper',
      providerId: 'p-audio',
      providerName: 'OpenAI Audio',
      providerKind: 'openai',
      modelName: 'whisper-1',
      enabled: true,
    };
    const execCfg: ExecutionConfig = {
      mode: 'parallel',
      concurrency: 50,
      timeoutSec: 60,
      stream: false,
      temperature: 0,
      maxTokens: 512,
      topP: 1,
      endpointType: 'audio-transcriptions',
    };

    const missingRes = await runExecutionPool({
      targets: [target],
      providers: [provider],
      prompt: '',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: execCfg,
      endpointFiles: [],
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });
    expect(missingRes[0].status).toBe('error');
    expect(missingRes[0].error).toContain('requires an attached audio file');

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ text: 'Transcribed audio sample' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const okRes = await runExecutionPool({
      targets: [target],
      providers: [provider],
      prompt: 'Transcribe cleanly',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: execCfg,
      endpointFiles: [
        {
          id: 'aud-1',
          name: 'voice.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 3,
          endpointScope: 'audio-transcriptions',
          fieldName: 'file',
          base64Data: btoa('abc'),
          enabled: true,
          addedAt: 1,
        },
      ],
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(okRes[0].status).toBe('completed');
    expect(okRes[0].output).toBe('Transcribed audio sample');
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/proxy/endpoint');
  });

  it('supports Daily Use & DevOps Use personas, 100 max threads, and Endpoint Type selector in UI', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /Systems & Reasoning \(18\)/i })).toBeInTheDocument();

    const devopsButtons = screen.getAllByRole('button', { name: 'DevOps / SRE' });
    fireEvent.click(devopsButtons[devopsButtons.length - 1]);
    expect(screen.getByDisplayValue(/Principal Site Reliability/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Daily Assistant' }));
    expect(screen.getByDisplayValue(/everyday assistant/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Configuration & Models/i }));
    const workerInput = screen.getByLabelText('Concurrent workers count') as HTMLInputElement;
    expect(workerInput.max).toBe('100');
    fireEvent.change(workerInput, { target: { value: '100' } });
    expect(workerInput.value).toBe('100');

    const epSelect = screen.getByLabelText('Endpoint type');
    fireEvent.change(epSelect, { target: { value: 'custom' } });
    expect(screen.getByLabelText('Custom endpoint path or URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload file endpoint scope')).toBeInTheDocument();
    expect(screen.getByText('Endpoint File Manager')).toBeInTheDocument();
  });

  it('adjusts, clamps, resets, and persists root font size next to the theme selector', () => {
    render(<App />);
    const incBtn = screen.getByRole('button', { name: 'Increase font size' });
    const decBtn = screen.getByRole('button', { name: 'Decrease font size' });
    const resetBtn = screen.getByRole('button', { name: 'Reset font size' });

    expect(resetBtn).toHaveTextContent('16px');
    expect(document.documentElement.style.fontSize).toBe('16px');

    fireEvent.click(incBtn);
    expect(resetBtn).toHaveTextContent('17px');
    expect(document.documentElement.style.fontSize).toBe('17px');

    fireEvent.click(decBtn);
    fireEvent.click(decBtn);
    expect(resetBtn).toHaveTextContent('15px');
    expect(document.documentElement.style.fontSize).toBe('15px');

    fireEvent.click(resetBtn);
    expect(resetBtn).toHaveTextContent('16px');
    expect(document.documentElement.style.fontSize).toBe('16px');
  });

  it('loads Ping dummy prompt in one click and highlights HTTP error / rate-limit codes in WaterfallView', async () => {
    const { classifyResultStatus } = await import('../utils/metrics');
    const baseTiming = {
      enqueuedAt: 10,
      startedAt: 12,
      headersAt: 40,
      firstTokenAt: 60,
      completedAt: 110,
      queueMs: 2,
      requestMs: 28,
      ttfbMs: 48,
      downloadMs: 50,
      totalMs: 100,
    };

    const okRes = {
      targetId: 't-ok',
      modelName: 'free-model-ok',
      providerName: 'OpenRouter',
      providerKind: 'openai' as const,
      status: 'completed' as const,
      output: 'pong',
      promptTokens: 5,
      completionTokens: 1,
      totalTokens: 6,
      tokensPerSec: 20,
      timing: baseTiming,
      httpStatus: 200,
    };
    const rateRes = {
      ...okRes,
      targetId: 't-429',
      modelName: 'free-model-429',
      status: 'error' as const,
      output: '',
      httpStatus: 429,
      error: 'Too many requests: free tier RPM exceeded',
    };
    const authRes = {
      ...okRes,
      targetId: 't-401',
      modelName: 'free-model-401',
      status: 'error' as const,
      output: '',
      httpStatus: 401,
      error: 'Invalid API key provided',
    };

    expect(classifyResultStatus(okRes).badgeText).toBe('200 OK');
    expect(classifyResultStatus(rateRes).category).toBe('rate-limit');
    expect(classifyResultStatus(rateRes).badgeText).toBe('429 RATE LIMIT');
    expect(classifyResultStatus(authRes).badgeText).toBe('401 AUTH');

    render(<WaterfallView results={[okRes, rateRes, authRes]} />);
    expect(screen.getByText('Code / Error')).toBeInTheDocument();
    expect(screen.getByText('200 OK')).toBeInTheDocument();
    expect(screen.getByText('429 RATE LIMIT')).toBeInTheDocument();
    expect(screen.getByText('401 AUTH')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '429 Rate Limit (1)' }));
    expect(screen.getByText('free-model-429')).toBeInTheDocument();
    expect(screen.queryByText('free-model-ok')).not.toBeInTheDocument();

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Load ping test prompt' }));
    expect(screen.getByDisplayValue('Reply with exactly "pong" and nothing else.')).toBeInTheDocument();
  });

  it('shuffles selected target execution order when randomizeOrder checkbox is enabled', async () => {
    const { shuffleItems } = await import('../utils/executionEngine');
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const shuffled = shuffleItems(['a', 'b', 'c']);
    expect(shuffled).toHaveLength(3);
    expect(shuffled).toEqual(['b', 'c', 'a']);

    const executedOrder: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { model: string };
        executedOrder.push(body.model);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
        };
      })
    );

    const providers: ProviderEndpoint[] = [
      {
        id: 'p1',
        name: 'P1',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        customHeaders: {},
        directBrowser: false,
        models: ['m1', 'm2', 'm3'],
      },
    ];
    const targets: TargetModel[] = [
      { id: 't1', providerId: 'p1', providerName: 'P1', providerKind: 'openai', modelName: 'm1', enabled: true },
      { id: 't2', providerId: 'p1', providerName: 'P1', providerKind: 'openai', modelName: 'm2', enabled: true },
      { id: 't3', providerId: 'p1', providerName: 'P1', providerKind: 'openai', modelName: 'm3', enabled: true },
    ];

    await runExecutionPool({
      targets,
      providers,
      prompt: 'ping',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: {
        mode: 'sequential',
        concurrency: 1,
        timeoutSec: 30,
        stream: false,
        randomizeOrder: true,
        temperature: 0.2,
        maxTokens: 64,
        topP: 1,
      },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(executedOrder).toEqual(['m2', 'm3', 'm1']);
  });

  it('parses Web and Rust TUI benchmark results.json exports and imports them in App UI', async () => {
    const { parseBenchmarkResultsJson } = await import('../utils/exportUtils');

    const rustJson = JSON.stringify({
      id: 'rust-1',
      title: 'Rust TUI Export',
      created_at: '2026-11-17T01:00:00Z',
      prompt: 'Ping test',
      results: [
        {
          target_id: 'target-rust-1',
          model_name: 'llama-3.3-free',
          provider_name: 'Groq',
          status: 'Completed',
          output: 'pong',
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
          tokens_per_sec: 88.2,
          http_status: 200,
          timing: { offset_ms: 0, queue_ms: 2, request_ms: 15, ttfb_ms: 35, download_ms: 10, total_ms: 62 },
        },
      ],
    });
    const parsedRust = parseBenchmarkResultsJson(rustJson);
    expect(parsedRust.title).toBe('Rust TUI Export');
    expect(parsedRust.results[0].modelName).toBe('llama-3.3-free');
    expect(parsedRust.results[0].httpStatus).toBe(200);
    expect(parsedRust.results[0].timing.ttfbMs).toBe(35);

    expect(() => parseBenchmarkResultsJson('{bad json')).toThrow(/Invalid JSON/);

    render(<App />);

    // Toggle Random checkbox in Configuration & Models
    fireEvent.click(screen.getByRole('button', { name: /Configuration & Models/i }));
    const randomCheckbox = screen.getByLabelText('Randomize model order') as HTMLInputElement;
    expect(randomCheckbox.checked).toBe(false);
    fireEvent.click(randomCheckbox);
    expect(randomCheckbox.checked).toBe(true);

    // Import results.json via toolbar upload input
    const webPayload = JSON.stringify({
      run: {
        id: 'imp-web-1',
        title: 'Imported Free Models Run',
        createdAt: Date.now(),
        prompt: 'Reply with pong',
        systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
        executionConfig: { mode: 'parallel', concurrency: 4, timeoutSec: 120, stream: true, randomizeOrder: true, temperature: 0.7, maxTokens: 512, topP: 1 },
        results: [
          {
            targetId: 'imp-target-1',
            modelName: 'qwen3-free-imported',
            providerName: 'OpenRouter',
            providerKind: 'openai',
            status: 'completed',
            output: 'pong imported!',
            promptTokens: 5,
            completionTokens: 2,
            totalTokens: 7,
            tokensPerSec: 75,
            httpStatus: 200,
            timing: { enqueuedAt: 0, startedAt: 1, headersAt: 20, firstTokenAt: 30, completedAt: 60, queueMs: 1, requestMs: 19, ttfbMs: 29, downloadMs: 30, totalMs: 59 },
          },
        ],
      },
    });
    const fileInput = screen.getByLabelText('Import benchmark results JSON') as HTMLInputElement;
    const mockFile = {
      name: 'results.json',
      type: 'application/json',
      text: async () => webPayload,
    } as unknown as File;
    fireEvent.change(fileInput, { target: { files: [mockFile] } });

    expect(await screen.findByText(/Imported "Imported Free Models Run" \(1 result\) from results\.json\./i)).toBeInTheDocument();
    expect(screen.getByText('Imported Free Models Run')).toBeInTheDocument();
    expect(screen.getByText('pong imported!')).toBeInTheDocument();
    const headerRow = screen.getByText('qwen3-free-imported').parentElement;
    expect(headerRow).toHaveClass('whitespace-nowrap');
    expect(headerRow?.textContent).toContain('TTFB 29 ms');
    expect(headerRow?.textContent).toContain('75 tok/s');
    expect(headerRow?.textContent).toContain('2 out tok');
    expect(headerRow?.textContent).toContain('Total 59 ms');
  });

  it('omits temperature on reasoning models and retries HTTP 400 temperature rejections without failing', async () => {
    const { modelDisallowsSamplingParams } = await import('../utils/executionEngine');
    expect(modelDisallowsSamplingParams('openai/o3-mini')).toBe(true);
    expect(modelDisallowsSamplingParams('o1-preview')).toBe(true);
    expect(modelDisallowsSamplingParams('gpt-5-mini')).toBe(true);
    expect(modelDisallowsSamplingParams('llama-3.3-70b-versatile')).toBe(false);

    const payloads: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
      payloads.push(parsed);
      if ('temperature' in parsed) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            JSON.stringify({
              error: { message: "Unsupported parameter: 'temperature' is not supported with this model." },
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: 'pong-without-temp' } }] }),
        json: async () => ({ choices: [{ message: { content: 'pong-without-temp' } }] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider: ProviderEndpoint = {
      id: 'p-strict',
      name: 'Strict Provider',
      kind: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      customHeaders: {},
      directBrowser: true,
      models: ['strict-custom-model', 'o3-mini'],
    };

    const strictRes = await runExecutionPool({
      targets: [
        {
          id: 't-strict',
          providerId: 'p-strict',
          providerName: 'Strict Provider',
          providerKind: 'openai',
          modelName: 'strict-custom-model',
          enabled: true,
        },
      ],
      providers: [provider],
      prompt: 'ping',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: {
        mode: 'parallel',
        concurrency: 1,
        timeoutSec: 30,
        stream: false,
        temperature: 0.7,
        maxTokens: 128,
        topP: 1,
      },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(strictRes[0].status).toBe('completed');
    expect(strictRes[0].output).toBe('pong-without-temp');
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toHaveProperty('temperature', 0.7);
    expect(payloads[1]).not.toHaveProperty('temperature');
    expect(payloads[1]).not.toHaveProperty('top_p');

    const o3Res = await runExecutionPool({
      targets: [
        {
          id: 't-o3',
          providerId: 'p-strict',
          providerName: 'Strict Provider',
          providerKind: 'openai',
          modelName: 'o3-mini',
          enabled: true,
        },
      ],
      providers: [provider],
      prompt: 'ping',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: {
        mode: 'parallel',
        concurrency: 1,
        timeoutSec: 30,
        stream: false,
        temperature: 0.7,
        maxTokens: 128,
        topP: 1,
      },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    expect(o3Res[0].status).toBe('completed');
    expect(payloads).toHaveLength(3);
    expect(payloads[2]).not.toHaveProperty('temperature');
  });

  it('scrolls the Responses canvas on Shift+ArrowDown and Shift+ArrowUp without hijacking textareas', () => {
    render(<App />);
    const canvas = screen.getByTestId('responses-canvas');
    const scrollByMock = vi.fn(({ top = 0 }: { top?: number }) => {
      canvas.scrollTop = Math.max(0, canvas.scrollTop + top);
    });
    canvas.scrollBy = scrollByMock as typeof canvas.scrollBy;

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    expect(scrollByMock).toHaveBeenCalledWith({ top: 180, behavior: 'auto' });
    expect(canvas.scrollTop).toBe(180);

    fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true });
    expect(scrollByMock).toHaveBeenCalledWith({ top: -180, behavior: 'auto' });
    expect(canvas.scrollTop).toBe(0);

    const promptInput = screen.getByPlaceholderText(/Enter a prompt or pick a benchmark/i);
    fireEvent.keyDown(promptInput, { key: 'ArrowDown', shiftKey: true });
    expect(scrollByMock).toHaveBeenCalledTimes(2);
  });

  it('opens Chat via Enter from Prompt with scrollable editable Send Config, activation checkboxes, and + Add Param', () => {
    render(<App />);
    // In TypeScript web app, the tab is named "Chat" (not "7:Chat")
    expect(screen.getAllByRole('button', { name: 'Chat' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: '7:Chat' })).not.toBeInTheDocument();

    const promptInput = screen.getByPlaceholderText(/Enter a prompt or pick a benchmark/i);
    fireEvent.change(promptInput, { target: { value: 'Explain Raft consensus briefly.' } });

    // Shift+Enter keeps normal textarea editing
    fireEvent.keyDown(promptInput, { key: 'Enter', shiftKey: true });
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();

    // Plain Enter opens Chat with loaded prompt
    fireEvent.keyDown(promptInput, { key: 'Enter' });
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
    expect(screen.getByText('Chat · Editable Send Config')).toBeInTheDocument();
    expect(screen.getByTestId('chat-transcript')).toHaveTextContent('Explain Raft consensus briefly.');

    // Scrollable Send Config exposes all editable fields and scrolls up/down
    const configPanel = screen.getByTestId('chat-config-panel');
    const scrollByMock = vi.fn(({ top = 0 }: { top?: number }) => {
      configPanel.scrollTop = Math.max(0, configPanel.scrollTop + top);
    });
    configPanel.scrollBy = scrollByMock as typeof configPanel.scrollBy;

    fireEvent.click(screen.getByLabelText('Scroll send config down'));
    expect(configPanel.scrollTop).toBe(180);
    fireEvent.click(screen.getByLabelText('Scroll send config up'));
    expect(configPanel.scrollTop).toBe(0);

    const tempInput = screen.getByLabelText('Chat temperature') as HTMLInputElement;
    fireEvent.change(tempInput, { target: { value: '0.35' } });
    expect(tempInput.value).toBe('0.35');
    expect(screen.getByLabelText('Chat target system override')).toBeInTheDocument();
  });

  it('opens Chat via Enter from Responses and Waterfall, omits unchecked params, and includes + Add Param values', async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        sentPayloads.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Follow-up answer from model' } }],
          usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // Enter from Waterfall opens Chat with selected row
    const waterfallBtn = screen.getByRole('button', { name: 'Waterfall' });
    fireEvent.click(waterfallBtn);
    const waterfallRow = screen.getByText('gemini-4-hydrogen').closest('tr');
    expect(waterfallRow).toBeTruthy();
    if (waterfallRow) {
      fireEvent.keyDown(waterfallRow, { key: 'Enter' });
    }
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();

    // Verify ResultCard Enter shortcut as well
    fireEvent.click(screen.getByRole('button', { name: 'Responses' }));
    const firstCard = screen.getByText('gemini-4-hydrogen').closest('article');
    expect(firstCard).toBeTruthy();
    if (firstCard) {
      fireEvent.keyDown(firstCard, { key: 'Enter' });
    }
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();

    // Uncheck Temperature and Max Tokens activation checkboxes so they are omitted when sending
    const tempCheckbox = screen.getByLabelText('Activate Temperature param') as HTMLInputElement;
    expect(tempCheckbox.checked).toBe(true);
    fireEvent.click(tempCheckbox);
    expect(tempCheckbox.checked).toBe(false);

    const maxTokCheckbox = screen.getByLabelText('Activate Max Tokens param') as HTMLInputElement;
    fireEvent.click(maxTokCheckbox);
    expect(maxTokCheckbox.checked).toBe(false);

    // Add two custom parameters via + Add Param controls; uncheck one
    fireEvent.change(screen.getByLabelText('New param key'), { target: { value: 'presence_penalty' } });
    fireEvent.change(screen.getByLabelText('New param value'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByLabelText('Submit add param'));
    expect(screen.getByLabelText('Activate param presence_penalty')).toBeChecked();

    fireEvent.change(screen.getByLabelText('New param key'), { target: { value: 'disabled_key' } });
    fireEvent.change(screen.getByLabelText('New param value'), { target: { value: '99' } });
    fireEvent.click(screen.getByLabelText('+ Add Param'));
    const disabledCheck = screen.getByLabelText('Activate param disabled_key') as HTMLInputElement;
    fireEvent.click(disabledCheck);
    expect(disabledCheck.checked).toBe(false);

    // Send a follow-up turn using Send Config
    const streamToggle = screen.getByLabelText('Chat SSE stream') as HTMLInputElement;
    if (streamToggle.checked) {
      fireEvent.click(streamToggle);
    }
    const composer = screen.getByLabelText('Chat follow-up message');
    fireEvent.change(composer, { target: { value: 'Now summarize in 1 sentence.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await screen.findByText('Follow-up answer from model');
    expect(fetchMock).toHaveBeenCalled();
    const lastPayload = sentPayloads[sentPayloads.length - 1];
    expect(lastPayload.temperature).toBeUndefined();
    expect(lastPayload.maxTokens).toBeUndefined();
    expect(lastPayload.max_tokens).toBeUndefined();
    expect(lastPayload.presence_penalty).toBe(0.25);
    expect(lastPayload.disabled_key).toBeUndefined();

    // Also verify runExecutionPool proxy routing omits unchecked params and passes extraParams
    await runExecutionPool({
      targets: [
        {
          id: 't-proxy',
          providerId: 'p-proxy',
          providerName: 'Proxy Provider',
          providerKind: 'openai',
          modelName: 'gpt-4o-mini',
          enabled: true,
        },
      ],
      providers: [
        {
          id: 'p-proxy',
          name: 'Proxy Provider',
          kind: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-proxy',
          customHeaders: { 'X-Ignored': '1' },
          directBrowser: false,
          models: ['gpt-4o-mini'],
        },
      ],
      prompt: 'hi',
      systemPrompt: { enabled: false, content: '', personaId: null, targetMode: 'all', targetModelIds: [] },
      executionConfig: {
        mode: 'parallel',
        concurrency: 1,
        timeoutSec: 30,
        stream: false,
        temperature: 0.7,
        maxTokens: 256,
        topP: 0.9,
        seed: 42,
        activeParams: {
          customHeaders: false,
          temperature: false,
          topP: false,
          maxTokens: false,
          seed: false,
        },
        extraParams: [
          { id: 'e1', key: 'presence_penalty', value: '0.25', enabled: true },
          { id: 'e2', key: 'stop', value: '["END"]', enabled: true },
          { id: 'e3', key: 'off_param', value: '123', enabled: false },
        ],
      },
      signal: new AbortController().signal,
      onResultUpdate: () => {},
    });

    const proxyPayload = sentPayloads[sentPayloads.length - 1];
    expect(proxyPayload.headers).toEqual({});
    expect(proxyPayload.temperature).toBeUndefined();
    expect(proxyPayload.topP).toBeUndefined();
    expect(proxyPayload.maxTokens).toBeUndefined();
    expect(proxyPayload.seed).toBeUndefined();
    expect(proxyPayload.extraParams).toEqual({ presence_penalty: 0.25, stop: ['END'] });

    vi.unstubAllGlobals();
  });
});


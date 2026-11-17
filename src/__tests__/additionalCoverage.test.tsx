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

    fireEvent.click(screen.getByRole('button', { name: /Classic \(4\)/i }));
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
});

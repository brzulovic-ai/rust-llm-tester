import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileJson,
  Menu,
  Play,
  RotateCcw,
  Share2,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { CapabilityGraphView } from './components/CapabilityGraphView';
import { DiffCompareView } from './components/DiffCompareView';
import { ResultCard } from './components/ResultCard';
import { RustTuiModal } from './components/RustTuiModal';
import { SidebarAccordion } from './components/SidebarAccordion';
import { WaterfallView } from './components/WaterfallView';
import { PROMPT_SUITES } from './data/promptSuites';
import type {
  BenchmarkRunRecord,
  ExecutionConfig,
  ModelRunResult,
  ProviderEndpoint,
  SupabaseConfig,
  SyncLogEntry,
  SystemPromptConfig,
  TargetModel,
  ThemeId,
  WorkspaceView,
} from './types/benchmark';
import { executeSingleTarget, runExecutionPool } from './utils/executionEngine';
import { buildCsvExport, buildJsonExport, triggerFileDownload } from './utils/exportUtils';
import {
  clearHistory,
  deleteRunFromHistory,
  loadHistory,
  loadProviders,
  loadSupabaseConfig,
  loadTargets,
  loadTheme,
  saveProviders,
  saveRunToHistory,
  saveSupabaseConfig,
  saveTargets,
  saveTheme,
} from './utils/historyStore';
import { createInitialTiming, formatMs } from './utils/metrics';
import { buildShareUrl, decodeShareState } from './utils/shareUtils';
import {
  pullRunsFromSupabase,
  pushRunToSupabase,
  testSupabaseConnection,
} from './utils/supabaseSync';

const THEME_OPTIONS: Array<{ id: ThemeId; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'sepia-light', label: 'Sepia Light' },
  { id: 'sepia-dark', label: 'Sepia Dark' },
  { id: 'greenish-sepia', label: 'Greenish Sepia' },
];

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(() => loadTheme());
  const [activeView, setActiveView] = useState<WorkspaceView>('cards');
  const [sidebarWidth, setSidebarWidth] = useState<number>(360);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);

  const [providers, setProviders] = useState<ProviderEndpoint[]>(() => loadProviders());
  const [targets, setTargets] = useState<TargetModel[]>(() => loadTargets());
  const [history, setHistory] = useState<BenchmarkRunRecord[]>(() => loadHistory());
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(() => loadSupabaseConfig());
  const [syncLogs, setSyncLogs] = useState<SyncLogEntry[]>([]);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [prompt, setPrompt] = useState<string>(PROMPT_SUITES[0].prompt);
  const [runTitle, setRunTitle] = useState<string>(PROMPT_SUITES[0].title);
  const [suiteName, setSuiteName] = useState<string | undefined>(PROMPT_SUITES[0].suiteLabel);

  const [systemPrompt, setSystemPrompt] = useState<SystemPromptConfig>({
    enabled: false,
    content: '',
    personaId: null,
    targetMode: 'all',
    targetModelIds: [],
  });

  const [executionConfig, setExecutionConfig] = useState<ExecutionConfig>({
    mode: 'parallel',
    concurrency: 3,
    timeoutSec: 300,
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1,
  });

  const [resultsMap, setResultsMap] = useState<Record<string, ModelRunResult>>({});
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [shareCopied, setShareCopied] = useState<boolean>(false);
  const [cardLayout, setCardLayout] = useState<'grid' | 'split'>('grid');
  const [rustTuiOpen, setRustTuiOpen] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const isResizingRef = useRef<boolean>(false);

  // Sync theme to documentElement
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    if (theme === 'dark' || theme === 'sepia-dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveTheme(theme);
  }, [theme]);

  // Persist providers, targets, and supabase config
  useEffect(() => {
    saveProviders(providers);
  }, [providers]);

  useEffect(() => {
    saveTargets(targets);
  }, [targets]);

  useEffect(() => {
    saveSupabaseConfig(supabaseConfig);
  }, [supabaseConfig]);

  // Hydrate shared benchmark link from URL hash on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const decoded = decodeShareState(window.location.hash);
    if (decoded) {
      setPrompt(decoded.prompt);
      setRunTitle(decoded.title);
      setSuiteName(decoded.suiteName);
      setSystemPrompt(decoded.systemPrompt);
      setExecutionConfig(decoded.executionConfig);
      const hydratedMap: Record<string, ModelRunResult> = {};
      decoded.results.forEach((r) => {
        hydratedMap[r.targetId] = r;
      });
      setResultsMap(hydratedMap);
    }
  }, []);

  // Resizable sidebar pointer listeners (mouse + touch)
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!isResizingRef.current) return;
      const clamped = Math.min(Math.max(e.clientX, 270), 560);
      setSidebarWidth(clamped);
    };
    const onPointerUp = () => {
      isResizingRef.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const enabledTargets = useMemo(() => targets.filter((t) => t.enabled), [targets]);

  const orderedResults = useMemo(() => {
    const list: ModelRunResult[] = [];
    const seen = new Set<string>();
    for (const t of enabledTargets) {
      seen.add(t.id);
      if (resultsMap[t.id]) {
        list.push(resultsMap[t.id]);
      } else {
        list.push({
          targetId: t.id,
          modelName: t.modelName,
          providerName: t.providerName,
          providerKind: t.providerKind,
          status: 'idle',
          output: '',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          tokensPerSec: 0,
          timing: createInitialTiming(0),
        });
      }
    }
    // Also include results from loaded history/shared links whose targetId isn't in current enabledTargets
    for (const [id, res] of Object.entries(resultsMap)) {
      if (!seen.has(id)) {
        list.push(res);
      }
    }
    return list;
  }, [enabledTargets, resultsMap]);

  const persistCompletedRun = useCallback(
    async (finalResults: ModelRunResult[]) => {
      if (finalResults.length === 0) return;
      const record: BenchmarkRunRecord = {
        id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: runTitle || prompt.slice(0, 48) || 'Benchmark Run',
        createdAt: Date.now(),
        prompt,
        suiteName,
        systemPrompt,
        executionConfig,
        results: finalResults,
      };
      setHistory(saveRunToHistory(record));

      if (supabaseConfig.autoSync && supabaseConfig.url && supabaseConfig.anonKey) {
        setIsSyncing(true);
        const log = await pushRunToSupabase(supabaseConfig, record);
        setSyncLogs((prev) => [log, ...prev].slice(0, 40));
        setIsSyncing(false);
      }
    },
    [runTitle, prompt, suiteName, systemPrompt, executionConfig, supabaseConfig]
  );

  const handleRunBenchmark = async () => {
    if (isRunning) {
      abortControllerRef.current?.abort('cancelled');
      setIsRunning(false);
      return;
    }

    if (!prompt.trim() || enabledTargets.length === 0) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRunning(true);
    setResultsMap({});

    const finalResults = await runExecutionPool({
      targets: enabledTargets,
      providers,
      prompt,
      systemPrompt,
      executionConfig,
      signal: controller.signal,
      onResultUpdate: (targetId, partial) => {
        setResultsMap((prev) => ({ ...prev, [targetId]: partial }));
      },
    });

    setIsRunning(false);
    abortControllerRef.current = null;
    await persistCompletedRun(finalResults);
  };

  const handleRetrySingle = async (targetId: string) => {
    const target = targets.find((t) => t.id === targetId);
    const provider = target ? providers.find((p) => p.id === target.providerId) : undefined;
    if (!target || !provider) return;

    const controller = new AbortController();
    const res = await executeSingleTarget({
      target,
      provider,
      prompt,
      systemPrompt,
      executionConfig,
      enqueuedAt: performance.now(),
      signal: controller.signal,
      onUpdate: (partial) => {
        setResultsMap((prev) => ({ ...prev, [targetId]: partial }));
      },
    });
    setResultsMap((prev) => ({ ...prev, [targetId]: res }));
  };

  const retryableTargets = useMemo(() => {
    return enabledTargets.filter((t) => {
      const r = resultsMap[t.id];
      return !r || r.status === 'error' || r.status === 'aborted' || r.status === 'idle' || r.status === 'queued';
    });
  }, [enabledTargets, resultsMap]);

  const handleBulkRetry = async () => {
    if (isRunning || retryableTargets.length === 0) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRunning(true);

    await runExecutionPool({
      targets: retryableTargets,
      providers,
      prompt,
      systemPrompt,
      executionConfig,
      signal: controller.signal,
      onResultUpdate: (targetId, partial) => {
        setResultsMap((prev) => ({ ...prev, [targetId]: partial }));
      },
    });

    setIsRunning(false);
    abortControllerRef.current = null;
  };

  const handleExportJson = () => {
    const record: BenchmarkRunRecord = {
      id: `export-${Date.now()}`,
      title: runTitle || 'Benchmark Export',
      createdAt: Date.now(),
      prompt,
      suiteName,
      systemPrompt,
      executionConfig,
      results: orderedResults,
    };
    triggerFileDownload(
      `benchmark-${Date.now()}.json`,
      buildJsonExport(record),
      'application/json'
    );
  };

  const handleExportCsv = () => {
    triggerFileDownload(
      `benchmark-${Date.now()}.csv`,
      buildCsvExport(orderedResults, prompt),
      'text/csv;charset=utf-8'
    );
  };

  const handleShareLink = () => {
    const url = buildShareUrl(window.location.href, {
      title: runTitle || 'Shared Benchmark',
      prompt,
      suiteName,
      systemPrompt,
      executionConfig,
      results: orderedResults,
    });
    window.history.replaceState(null, '', url);
    navigator.clipboard?.writeText(url).catch(() => {});
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const handleLoadHistoryRun = (run: BenchmarkRunRecord) => {
    setPrompt(run.prompt);
    setRunTitle(run.title);
    setSuiteName(run.suiteName);
    setSystemPrompt(run.systemPrompt);
    setExecutionConfig(run.executionConfig);
    const map: Record<string, ModelRunResult> = {};
    run.results.forEach((r) => {
      map[r.targetId] = r;
    });
    setResultsMap(map);
    setMobileSidebarOpen(false);
  };

  const handleTestSupabase = async () => {
    setIsSyncing(true);
    const log = await testSupabaseConnection(supabaseConfig);
    setSyncLogs((prev) => [log, ...prev].slice(0, 40));
    setIsSyncing(false);
  };

  const handlePushSupabase = async () => {
    setIsSyncing(true);
    const latestRun: BenchmarkRunRecord = history[0] ?? {
      id: `run-${Date.now()}`,
      title: runTitle || 'Benchmark Run',
      createdAt: Date.now(),
      prompt,
      suiteName,
      systemPrompt,
      executionConfig,
      results: orderedResults,
    };
    const log = await pushRunToSupabase(supabaseConfig, latestRun);
    setSyncLogs((prev) => [log, ...prev].slice(0, 40));
    setIsSyncing(false);
  };

  const handlePullSupabase = async () => {
    setIsSyncing(true);
    const { log, runs } = await pullRunsFromSupabase(supabaseConfig);
    setSyncLogs((prev) => [log, ...prev].slice(0, 40));
    if (runs.length > 0) {
      let updated = history;
      for (const r of [...runs].reverse()) {
        updated = saveRunToHistory(r);
      }
      setHistory(updated);
    }
    setIsSyncing(false);
  };

  // Summary Stats
  const completedResults = orderedResults.filter((r) => r.status === 'completed');
  const avgTtfbMs =
    completedResults.length > 0
      ? completedResults.reduce((acc, r) => acc + (r.timing.ttfbMs ?? 0), 0) /
        completedResults.length
      : null;
  const peakSpeed =
    completedResults.length > 0
      ? Math.max(...completedResults.map((r) => r.tokensPerSec))
      : null;

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)' }}
    >
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header
        className="h-14 px-5 border-b flex items-center justify-between gap-8 shrink-0"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        {/* Zone 1: Single-line Wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}
            aria-label="Toggle configuration sidebar"
            className="lg:hidden p-1.5 rounded border cursor-pointer"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          >
            {mobileSidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <span
            className="text-base font-bold tracking-tight font-display whitespace-nowrap shrink-0"
            style={{ color: 'var(--text-primary)' }}
          >
            BenchForge
          </span>
        </div>

        {/* Zone 2: 4 Single-line View Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          {(
            [
              { id: 'cards', label: 'Responses' },
              { id: 'waterfall', label: 'Waterfall' },
              { id: 'compare', label: 'Diff Compare' },
              { id: 'graph', label: 'Capability Graph' },
            ] as Array<{ id: WorkspaceView; label: string }>
          ).map((nav) => {
            const active = activeView === nav.id;
            return (
              <button
                key={nav.id}
                type="button"
                onClick={() => setActiveView(nav.id)}
                className="py-1 border-b-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                style={{
                  borderColor: active ? 'var(--accent-primary)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {nav.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 Primary CTA */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleRunBenchmark}
            disabled={!isRunning && (!prompt.trim() || enabledTargets.length === 0)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            style={{
              backgroundColor: isRunning ? 'var(--status-error)' : 'var(--accent-primary)',
              color: isRunning ? '#ffffff' : 'var(--accent-contrast)',
            }}
          >
            {isRunning ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isRunning ? 'Stop Run' : 'Run Benchmark'}</span>
          </button>
        </div>
      </header>

      {/* Main Workspace: Resizable Sidebar + Viewport */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Sidebar */}
        <aside
          className={`${
            mobileSidebarOpen ? 'fixed inset-y-14 left-0 z-30 flex' : 'hidden lg:flex'
          } flex-col border-r shrink-0`}
          style={{
            width: `${sidebarWidth}px`,
            maxWidth: '88vw',
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-surface)',
          }}
        >
          <SidebarAccordion
            prompt={prompt}
            onPromptChange={(val) => {
              setPrompt(val);
              setSuiteName(undefined);
            }}
            selectedSuiteName={suiteName}
            onSelectSuitePrompt={(pText, title, sLabel) => {
              setPrompt(pText);
              setRunTitle(title);
              setSuiteName(sLabel);
              setMobileSidebarOpen(false);
            }}
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
            executionConfig={executionConfig}
            onExecutionConfigChange={setExecutionConfig}
            providers={providers}
            onProvidersChange={setProviders}
            targets={targets}
            onTargetsChange={setTargets}
            history={history}
            onLoadHistoryRun={handleLoadHistoryRun}
            onDeleteHistoryRun={(id) => setHistory(deleteRunFromHistory(id))}
            onClearHistory={() => {
              clearHistory();
              setHistory([]);
            }}
            supabaseConfig={supabaseConfig}
            onSupabaseConfigChange={setSupabaseConfig}
            syncLogs={syncLogs}
            onTestSupabase={handleTestSupabase}
            onPushSupabase={handlePushSupabase}
            onPullSupabase={handlePullSupabase}
            isSyncing={isSyncing}
          />
        </aside>

        {/* Drag Resize Handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={() => {
            isResizingRef.current = true;
            document.body.style.userSelect = 'none';
          }}
          className="hidden lg:block w-1.5 cursor-col-resize hover:opacity-100 opacity-0 transition-opacity shrink-0"
          style={{ backgroundColor: 'var(--accent-primary)' }}
        />

        {/* Workspace Viewport */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Workspace Toolbar (Theme, Mobile Views, Bulk Retry, Export, Share) */}
          <div
            className="px-5 py-2.5 border-b flex flex-wrap items-center justify-between gap-3 shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
            }}
          >
            {/* Unboxed Summary Readout */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-mono tabular-nums">
              <span className="font-semibold font-sans" style={{ color: 'var(--text-primary)' }}>
                {runTitle}
              </span>
              <span style={{ color: 'var(--text-muted)' }} aria-hidden="true">
                ·
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {enabledTargets.length} targets ({executionConfig.mode}
                {executionConfig.mode === 'parallel' ? ` ×${executionConfig.concurrency}` : ''})
              </span>
              {completedResults.length > 0 && (
                <>
                  <span style={{ color: 'var(--text-muted)' }} aria-hidden="true">
                    ·
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Avg TTFB {formatMs(avgTtfbMs)}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }} aria-hidden="true">
                    ·
                  </span>
                  <span style={{ color: 'var(--accent-primary)' }}>
                    Peak {peakSpeed} tok/s
                  </span>
                </>
              )}
            </div>

            {/* Utility Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Mobile view selector */}
              <select
                aria-label="Select workspace view"
                value={activeView}
                onChange={(e) => setActiveView(e.target.value as WorkspaceView)}
                className="md:hidden px-2 py-1.5 rounded border text-xs"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="cards">Responses</option>
                <option value="waterfall">Waterfall</option>
                <option value="compare">Diff Compare</option>
                <option value="graph">Capability Graph</option>
              </select>

              {activeView === 'cards' && (
                <div
                  className="hidden sm:flex items-center p-0.5 rounded-md border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-elevated)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setCardLayout('grid')}
                    className="px-2 py-1 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap shrink-0"
                    style={{
                      backgroundColor: cardLayout === 'grid' ? 'var(--bg-surface)' : 'transparent',
                      color: cardLayout === 'grid' ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    Cards
                  </button>
                  <button
                    type="button"
                    onClick={() => setCardLayout('split')}
                    className="px-2 py-1 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap shrink-0"
                    style={{
                      backgroundColor: cardLayout === 'split' ? 'var(--bg-surface)' : 'transparent',
                      color: cardLayout === 'split' ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    Split
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={handleBulkRetry}
                disabled={isRunning || retryableTargets.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Bulk Retry ({retryableTargets.length})</span>
              </button>

              <button
                type="button"
                onClick={handleExportCsv}
                disabled={orderedResults.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>

              <button
                type="button"
                onClick={handleExportJson}
                disabled={orderedResults.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                <FileJson className="w-3.5 h-3.5" />
                <span>JSON</span>
              </button>

              <button
                type="button"
                onClick={handleShareLink}
                disabled={orderedResults.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-secondary)',
                }}
              >
                {shareCopied ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
                <span>{shareCopied ? 'Link Copied' : 'Share'}</span>
              </button>

              <button
                type="button"
                onClick={() => setRustTuiOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Rust TUI</span>
              </button>

              <select
                aria-label="Theme selector"
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeId)}
                className="px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              >
                {THEME_OPTIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    Theme: {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Active View Canvas */}
          <div className="flex-1 overflow-y-auto p-5">
            {activeView === 'cards' && (
              orderedResults.length === 0 ? (
                <div
                  className="rounded-xl border p-8 text-center text-sm"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-muted)',
                  }}
                >
                  Enable one or more target models in Configuration & Models to start benchmarking.
                </div>
              ) : (
                <div
                  className={
                    cardLayout === 'split'
                      ? 'grid grid-cols-1 xl:grid-cols-2 gap-4'
                      : 'grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4'
                  }
                >
                  {orderedResults.map((result) => (
                    <ResultCard
                      key={result.targetId}
                      result={result}
                      onRetry={handleRetrySingle}
                    />
                  ))}
                </div>
              )
            )}

            {activeView === 'waterfall' && <WaterfallView results={orderedResults} />}

            {activeView === 'compare' && <DiffCompareView results={orderedResults} />}

            {activeView === 'graph' && <CapabilityGraphView results={orderedResults} />}
          </div>
        </main>
      </div>

      <RustTuiModal
        open={rustTuiOpen}
        onClose={() => setRustTuiOpen(false)}
        executionConfig={executionConfig}
        systemPrompt={systemPrompt}
        theme={theme}
        supabaseConfig={supabaseConfig}
        providers={providers}
        targets={targets}
        results={orderedResults}
        prompt={prompt}
      />
    </div>
  );
}

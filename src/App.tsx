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
  Upload,
  X,
} from 'lucide-react';
import { CapabilityGraphView } from './components/CapabilityGraphView';
import { ChatView } from './components/ChatView';
import { DiffCompareView } from './components/DiffCompareView';
import { ResultCard } from './components/ResultCard';
import { RustTuiModal } from './components/RustTuiModal';
import { SidebarAccordion } from './components/SidebarAccordion';
import { WaterfallView } from './components/WaterfallView';
import { PROMPT_SUITES } from './data/promptSuites';
import type {
  BenchmarkRunRecord,
  ChatTurnMessage,
  EndpointFileAttachment,
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
import { filesForEndpoint, getEndpointPreset } from './utils/endpointUtils';
import { executeSingleTarget, runExecutionPool } from './utils/executionEngine';
import {
  buildCsvExport,
  buildJsonExport,
  parseBenchmarkResultsJson,
  triggerFileDownload,
} from './utils/exportUtils';
import {
  clearHistory,
  DEFAULT_FONT_SIZE,
  deleteRunFromHistory,
  loadEndpointFiles,
  loadFontSize,
  loadHistory,
  loadProviders,
  loadSupabaseConfig,
  loadTargets,
  loadTheme,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  saveEndpointFiles,
  saveFontSize,
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
  const [fontSize, setFontSize] = useState<number>(() => loadFontSize());
  const [activeView, setActiveView] = useState<WorkspaceView>('cards');
  const [sidebarWidth, setSidebarWidth] = useState<number>(360);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);

  const [providers, setProviders] = useState<ProviderEndpoint[]>(() => loadProviders());
  const [targets, setTargets] = useState<TargetModel[]>(() => loadTargets());
  const [endpointFiles, setEndpointFiles] = useState<EndpointFileAttachment[]>(() => loadEndpointFiles());
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
    randomizeOrder: false,
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1,
    endpointType: 'chat-completions',
    customEndpoint: '',
    customPayloadMode: 'auto',
    ttsVoice: 'alloy',
  });

  const [resultsMap, setResultsMap] = useState<Record<string, ModelRunResult>>({});
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [shareCopied, setShareCopied] = useState<boolean>(false);
  const [importFeedback, setImportFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);
  const [cardLayout, setCardLayout] = useState<'grid' | 'split'>('grid');
  const [rustTuiOpen, setRustTuiOpen] = useState<boolean>(false);
  const [selectedResultTargetId, setSelectedResultTargetId] = useState<string | null>(null);
  const [chatTargetId, setChatTargetId] = useState<string>(() => targets[0]?.id ?? '');
  const [chatMessages, setChatMessages] = useState<ChatTurnMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatRunning, setChatRunning] = useState<boolean>(false);
  const [chatLastResult, setChatLastResult] = useState<ModelRunResult | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
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

  // Sync root font size to documentElement
  useEffect(() => {
    const clamped = Math.min(Math.max(Math.round(fontSize), MIN_FONT_SIZE), MAX_FONT_SIZE);
    document.documentElement.style.fontSize = `${clamped}px`;
    saveFontSize(clamped);
  }, [fontSize]);

  // Persist providers, targets, and supabase config
  useEffect(() => {
    saveProviders(providers);
  }, [providers]);

  useEffect(() => {
    saveTargets(targets);
  }, [targets]);

  useEffect(() => {
    saveEndpointFiles(endpointFiles);
  }, [endpointFiles]);

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

  // Shift+ArrowUp / Shift+ArrowDown scrolls the Responses canvas
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeView !== 'cards' || !e.shiftKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || targetEl?.isContentEditable) {
        return;
      }
      const container = canvasScrollRef.current;
      if (!container) return;
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 180 : -180;
      if (typeof container.scrollBy === 'function') {
        container.scrollBy({ top: delta, behavior: 'auto' });
      } else {
        container.scrollTop = Math.max(0, container.scrollTop + delta);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeView]);

  const enabledTargets = useMemo(() => targets.filter((t) => t.enabled), [targets]);
  const activeEndpointType = executionConfig.endpointType ?? 'chat-completions';
  const activeEndpointPreset = getEndpointPreset(activeEndpointType);
  const matchingEndpointFiles = useMemo(
    () => filesForEndpoint(endpointFiles, activeEndpointType),
    [endpointFiles, activeEndpointType]
  );
  const canStartRun =
    enabledTargets.length > 0 &&
    (Boolean(prompt.trim()) ||
      (activeEndpointPreset.requiresFile && matchingEndpointFiles.length > 0));

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

  const openChatWithResult = useCallback(
    (chosenResult?: ModelRunResult, promptOverride?: string, titleOverride?: string) => {
      const activePrompt = promptOverride ?? prompt;
      if (promptOverride !== undefined) {
        setPrompt(promptOverride);
      }
      if (titleOverride !== undefined) {
        setRunTitle(titleOverride);
      }

      const fallbackResult =
        orderedResults.find((r) => r.targetId === selectedResultTargetId) ?? orderedResults[0];
      const chosen = chosenResult ?? fallbackResult;

      const resolvedTargetId =
        chosen?.targetId ||
        (targets.some((t) => t.id === chatTargetId) ? chatTargetId : '') ||
        enabledTargets[0]?.id ||
        targets[0]?.id ||
        '';

      if (resolvedTargetId) {
        setChatTargetId(resolvedTargetId);
        setSelectedResultTargetId(resolvedTargetId);
      }
      setChatLastResult(chosen ?? null);

      const initialMessages: ChatTurnMessage[] = [];
      const now = Date.now();
      if (activePrompt.trim()) {
        initialMessages.push({
          id: `chat-u-${now}`,
          role: 'user',
          content: activePrompt,
          timestamp: now,
        });
      }

      if (chosen) {
        let assistantContent = '';
        if (chosen.output.trim()) {
          assistantContent = chosen.error
            ? `${chosen.output}\n\n[ERROR: ${chosen.error}]`
            : chosen.output;
        } else if (chosen.error) {
          assistantContent = chosen.advice
            ? `ERROR: ${chosen.error}\nADVICE: ${chosen.advice}`
            : `ERROR: ${chosen.error}`;
        }
        if (assistantContent) {
          initialMessages.push({
            id: `chat-a-${now + 1}`,
            role: 'assistant',
            content: assistantContent,
            timestamp: now + 1,
            modelName: chosen.modelName,
            providerName: chosen.providerName,
          });
        }
      }

      setChatMessages(initialMessages);
      setChatInput('');
      setActiveView('chat');
      setMobileSidebarOpen(false);
    },
    [
      prompt,
      orderedResults,
      selectedResultTargetId,
      targets,
      chatTargetId,
      enabledTargets,
    ]
  );

  const openChatFromPrompt = useCallback(
    (promptOverride?: string, titleOverride?: string) => {
      const activeId =
        selectedResultTargetId ||
        (targets.some((t) => t.id === chatTargetId) ? chatTargetId : '') ||
        enabledTargets[0]?.id ||
        targets[0]?.id ||
        '';
      const cached = orderedResults.find((r) => r.targetId === activeId) ?? orderedResults[0];
      const meaningfulCached =
        cached && (cached.output.trim().length > 0 || Boolean(cached.error)) ? cached : undefined;
      openChatWithResult(meaningfulCached, promptOverride, titleOverride);
    },
    [selectedResultTargetId, targets, chatTargetId, enabledTargets, orderedResults, openChatWithResult]
  );

  // Keyboard shortcuts: Enter from Responses/Waterfall opens 7:Chat, '7' opens 7:Chat
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        targetEl?.isContentEditable
      ) {
        return;
      }

      if (e.key === '7' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setActiveView('chat');
        return;
      }

      if (e.key === 'Enter' && (activeView === 'cards' || activeView === 'waterfall')) {
        if (tag === 'BUTTON' || tag === 'A') return;
        e.preventDefault();
        openChatWithResult();
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [activeView, openChatWithResult]);

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

    if (!canStartRun) return;

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
      endpointFiles,
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
      endpointFiles,
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
      endpointFiles,
      signal: controller.signal,
      onResultUpdate: (targetId, partial) => {
        setResultsMap((prev) => ({ ...prev, [targetId]: partial }));
      },
    });

    setIsRunning(false);
    abortControllerRef.current = null;
  };

  const handleSendChatTurn = async () => {
    if (chatRunning || isRunning) return;
    const activeTarget =
      targets.find((t) => t.id === chatTargetId) ?? enabledTargets[0] ?? targets[0];
    if (!activeTarget) return;
    const provider = providers.find((p) => p.id === activeTarget.providerId) ?? providers[0];
    if (!provider) return;

    const draft = chatInput.trim();
    const baseHistory: ChatTurnMessage[] = [...chatMessages];
    const now = Date.now();

    if (draft) {
      while (
        baseHistory.length > 0 &&
        baseHistory[baseHistory.length - 1]?.role === 'assistant' &&
        (baseHistory[baseHistory.length - 1].content.trim() === '' ||
          baseHistory[baseHistory.length - 1].content.trim() === '...' ||
          baseHistory[baseHistory.length - 1].content.trimStart().startsWith('ERROR:'))
      ) {
        baseHistory.pop();
      }
      baseHistory.push({
        id: `chat-u-${now}`,
        role: 'user',
        content: draft,
        timestamp: now,
      });
      setChatInput('');
    } else if (baseHistory.length === 0 && prompt.trim()) {
      baseHistory.push({
        id: `chat-u-${now}`,
        role: 'user',
        content: prompt,
        timestamp: now,
      });
    } else if (baseHistory[baseHistory.length - 1]?.role === 'assistant') {
      baseHistory.pop();
    }

    if (baseHistory.length === 0 && matchingEndpointFiles.length === 0) return;

    const assistantId = `chat-a-${Date.now()}`;
    const historyForRequest = baseHistory.map((m) => ({
      role: m.role,
      content: m.content,
      modelName: m.modelName,
    }));
    const lastUserContent =
      [...historyForRequest].reverse().find((m) => m.role === 'user')?.content ?? prompt;

    setChatMessages([
      ...baseHistory,
      {
        id: assistantId,
        role: 'assistant',
        content: '...',
        timestamp: Date.now(),
        modelName: activeTarget.modelName,
        providerName: provider.name,
      },
    ]);
    setChatRunning(true);

    const controller = new AbortController();
    chatAbortControllerRef.current = controller;

    const applyChatResultUpdate = (partial: ModelRunResult) => {
      setChatLastResult(partial);
      setResultsMap((prev) => ({ ...prev, [activeTarget.id]: partial }));
      const nextText = partial.output.trim()
        ? partial.error
          ? `${partial.output}\n\n[ERROR: ${partial.error}]`
          : partial.output
        : partial.error
        ? partial.advice
          ? `ERROR: ${partial.error}\nADVICE: ${partial.advice}`
          : `ERROR: ${partial.error}`
        : '...';
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: nextText,
                modelName: partial.modelName || m.modelName,
                providerName: partial.providerName || m.providerName,
              }
            : m
        )
      );
    };

    const finalRes = await executeSingleTarget({
      target: activeTarget,
      provider,
      prompt: lastUserContent,
      historyMessages: historyForRequest,
      systemPrompt,
      executionConfig,
      endpointFiles,
      enqueuedAt: performance.now(),
      signal: controller.signal,
      onUpdate: applyChatResultUpdate,
    });

    applyChatResultUpdate(finalRes);
    setChatRunning(false);
    chatAbortControllerRef.current = null;
  };

  const handleAbortChat = () => {
    chatAbortControllerRef.current?.abort('cancelled');
    setChatRunning(false);
  };

  const handleResetChat = () => {
    if (chatRunning) return;
    setChatMessages(
      prompt.trim()
        ? [
            {
              id: `chat-u-reset-${Date.now()}`,
              role: 'user',
              content: prompt,
              timestamp: Date.now(),
            },
          ]
        : []
    );
    setChatLastResult(null);
    setChatInput('');
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
    setExecutionConfig({
      randomizeOrder: false,
      ...run.executionConfig,
    });
    const map: Record<string, ModelRunResult> = {};
    run.results.forEach((r) => {
      map[r.targetId] = r;
    });
    setResultsMap(map);
    setMobileSidebarOpen(false);
  };

  const handleImportJsonFile = async (file: File) => {
    try {
      const rawText =
        typeof file.text === 'function'
          ? await file.text()
          : await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(new Error('Failed to read selected JSON file.'));
              reader.readAsText(file);
            });
      const imported = parseBenchmarkResultsJson(rawText);
      handleLoadHistoryRun(imported);
      setHistory(saveRunToHistory(imported));
      setImportFeedback({
        kind: 'success',
        message: `Imported "${imported.title}" (${imported.results.length} result${
          imported.results.length === 1 ? '' : 's'
        }) from ${file.name}.`,
      });
    } catch (err) {
      setImportFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to import benchmark JSON file.',
      });
    }
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
              { id: 'chat', label: 'Chat' },
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
            disabled={!isRunning && !canStartRun}
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
            onOpenChatFromPrompt={openChatFromPrompt}
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
            executionConfig={executionConfig}
            onExecutionConfigChange={setExecutionConfig}
            endpointFiles={endpointFiles}
            onEndpointFilesChange={setEndpointFiles}
            providers={providers}
            onProvidersChange={setProviders}
            targets={targets}
            onTargetsChange={setTargets}
            history={history}
            onLoadHistoryRun={handleLoadHistoryRun}
            onImportJsonFile={handleImportJsonFile}
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
              <span style={{ color: 'var(--text-muted)' }} aria-hidden="true">
                ·
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {activeEndpointType === 'custom' && executionConfig.customEndpoint?.trim()
                  ? executionConfig.customEndpoint.trim()
                  : activeEndpointPreset.pathLabel}
                {matchingEndpointFiles.length > 0 ? ` (${matchingEndpointFiles.length} files)` : ''}
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
                <option value="chat">Chat</option>
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
                onClick={() => importFileInputRef.current?.click()}
                title="Import benchmark results.json"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Import JSON</span>
              </button>
              <input
                ref={importFileInputRef}
                type="file"
                accept=".json,application/json"
                aria-label="Import benchmark results JSON"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void handleImportJsonFile(file);
                  }
                  e.target.value = '';
                }}
              />

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

              <div
                className="inline-flex items-center rounded-md border overflow-hidden shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                }}
                role="group"
                aria-label="Font size controls"
              >
                <button
                  type="button"
                  aria-label="Decrease font size"
                  title="Decrease font size"
                  disabled={fontSize <= MIN_FONT_SIZE}
                  onClick={() => setFontSize((prev) => Math.max(MIN_FONT_SIZE, prev - 1))}
                  className="px-2 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--text-primary)' }}
                >
                  A-
                </button>
                <button
                  type="button"
                  aria-label="Reset font size"
                  title={`Font size ${fontSize}px (click to reset to ${DEFAULT_FONT_SIZE}px)`}
                  onClick={() => setFontSize(DEFAULT_FONT_SIZE)}
                  className="px-2 py-1.5 text-[11px] font-mono tabular-nums border-x cursor-pointer whitespace-nowrap"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {fontSize}px
                </button>
                <button
                  type="button"
                  aria-label="Increase font size"
                  title="Increase font size"
                  disabled={fontSize >= MAX_FONT_SIZE}
                  onClick={() => setFontSize((prev) => Math.min(MAX_FONT_SIZE, prev + 1))}
                  className="px-2 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-40 whitespace-nowrap hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--text-primary)' }}
                >
                  A+
                </button>
              </div>
            </div>
          </div>

          {/* Active View Canvas */}
          <div
            ref={canvasScrollRef}
            data-testid="responses-canvas"
            className="flex-1 overflow-y-auto p-5"
          >
            {importFeedback && (
              <div
                role="status"
                className="mb-4 px-3 py-2 rounded-lg border flex items-center justify-between gap-3 text-xs"
                style={{
                  borderColor:
                    importFeedback.kind === 'error'
                      ? 'var(--status-error)'
                      : 'var(--status-success)',
                  backgroundColor: 'var(--bg-surface)',
                  color:
                    importFeedback.kind === 'error'
                      ? 'var(--status-error)'
                      : 'var(--text-primary)',
                }}
              >
                <span>{importFeedback.message}</span>
                <button
                  type="button"
                  aria-label="Dismiss import message"
                  onClick={() => setImportFeedback(null)}
                  className="p-0.5 rounded hover:opacity-75 cursor-pointer"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
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
                  {orderedResults.map((result, idx) => {
                    const effectiveSelected =
                      selectedResultTargetId ?? orderedResults[0]?.targetId ?? null;
                    return (
                      <ResultCard
                        key={result.targetId}
                        result={result}
                        onRetry={handleRetrySingle}
                        isSelected={
                          effectiveSelected === result.targetId ||
                          (effectiveSelected === null && idx === 0)
                        }
                        onSelect={(tid) => setSelectedResultTargetId(tid)}
                        onOpenChat={(res) => openChatWithResult(res)}
                      />
                    );
                  })}
                </div>
              )
            )}

            {activeView === 'waterfall' && (
              <WaterfallView
                results={orderedResults}
                selectedTargetId={selectedResultTargetId}
                onSelectResult={(tid) => setSelectedResultTargetId(tid)}
                onOpenChat={(res) => openChatWithResult(res)}
              />
            )}

            {activeView === 'compare' && <DiffCompareView results={orderedResults} />}

            {activeView === 'graph' && <CapabilityGraphView results={orderedResults} />}

            {activeView === 'chat' && (
              <ChatView
                targets={targets}
                onTargetsChange={setTargets}
                providers={providers}
                onProvidersChange={setProviders}
                executionConfig={executionConfig}
                onExecutionConfigChange={setExecutionConfig}
                systemPrompt={systemPrompt}
                onSystemPromptChange={setSystemPrompt}
                endpointFiles={endpointFiles}
                onEndpointFilesChange={setEndpointFiles}
                activeTargetId={chatTargetId}
                onActiveTargetIdChange={(id) => {
                  setChatTargetId(id);
                  setSelectedResultTargetId(id);
                }}
                messages={chatMessages}
                chatInput={chatInput}
                onChatInputChange={setChatInput}
                isRunning={chatRunning}
                lastResult={chatLastResult}
                onSendTurn={() => {
                  void handleSendChatTurn();
                }}
                onAbort={handleAbortChat}
                onResetChat={handleResetChat}
              />
            )}
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
        endpointFiles={endpointFiles}
        results={orderedResults}
        prompt={prompt}
      />
    </div>
  );
}

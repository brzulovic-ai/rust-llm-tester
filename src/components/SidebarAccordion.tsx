import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { PROMPT_SUITES, SYSTEM_PERSONAS } from '../data/promptSuites';
import type {
  BenchmarkRunRecord,
  ExecutionConfig,
  ProviderEndpoint,
  ProviderKind,
  SupabaseConfig,
  SyncLogEntry,
  SystemPromptConfig,
  TargetModel,
} from '../types/benchmark';
import { SUPABASE_TABLE_SQL } from '../utils/supabaseSync';

export type AccordionSectionId = 'prompt' | 'config' | 'history';

interface SidebarAccordionProps {
  prompt: string;
  onPromptChange: (val: string) => void;
  selectedSuiteName?: string;
  onSelectSuitePrompt: (promptText: string, title: string, suiteLabel: string) => void;
  systemPrompt: SystemPromptConfig;
  onSystemPromptChange: (next: SystemPromptConfig) => void;
  executionConfig: ExecutionConfig;
  onExecutionConfigChange: (next: ExecutionConfig) => void;
  providers: ProviderEndpoint[];
  onProvidersChange: (next: ProviderEndpoint[]) => void;
  targets: TargetModel[];
  onTargetsChange: (next: TargetModel[]) => void;
  history: BenchmarkRunRecord[];
  onLoadHistoryRun: (run: BenchmarkRunRecord) => void;
  onDeleteHistoryRun: (id: string) => void;
  onClearHistory: () => void;
  supabaseConfig: SupabaseConfig;
  onSupabaseConfigChange: (next: SupabaseConfig) => void;
  syncLogs: SyncLogEntry[];
  onTestSupabase: () => void;
  onPushSupabase: () => void;
  onPullSupabase: () => void;
  isSyncing: boolean;
}

const PROVIDER_TEMPLATES: Array<{ kind: ProviderKind; label: string; baseUrl: string; directBrowser: boolean; defaultModel: string }> = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', directBrowser: true, defaultModel: 'llama3.2:latest' },
  { kind: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', directBrowser: false, defaultModel: 'meta-llama/Llama-3.1-8B-Instruct' },
  { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', directBrowser: true, defaultModel: 'local-model' },
  { kind: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', directBrowser: false, defaultModel: 'llama-3.3-70b-versatile' },
  { kind: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4100/v1', directBrowser: false, defaultModel: 'gpt-4o-mini' },
  { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', directBrowser: false, defaultModel: 'gpt-4o-mini' },
  { kind: 'custom', label: 'Custom', baseUrl: 'https://api.example.com/v1', directBrowser: false, defaultModel: 'custom-model' },
];

export const SidebarAccordion: React.FC<SidebarAccordionProps> = ({
  prompt,
  onPromptChange,
  onSelectSuitePrompt,
  systemPrompt,
  onSystemPromptChange,
  executionConfig,
  onExecutionConfigChange,
  providers,
  onProvidersChange,
  targets,
  onTargetsChange,
  history,
  onLoadHistoryRun,
  onDeleteHistoryRun,
  onClearHistory,
  supabaseConfig,
  onSupabaseConfigChange,
  syncLogs,
  onTestSupabase,
  onPushSupabase,
  onPullSupabase,
  isSyncing,
}) => {
  // PRD 3.5: Configuration and History collapsed by default, Prompt active by default
  const [openSections, setOpenSections] = useState<Record<AccordionSectionId, boolean>>({
    prompt: true,
    config: false,
    history: false,
  });

  const [suiteTab, setSuiteTab] = useState<'nerdy-kings' | 'html-games' | 'classic-benchmarks'>(
    'nerdy-kings'
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    () => providers[0]?.id ?? 'provider-gemini-builtin'
  );
  const [newModelInput, setNewModelInput] = useState('');
  const [discoverStatus, setDiscoverStatus] = useState<string | null>(null);
  const [headerKeyInput, setHeaderKeyInput] = useState('');
  const [headerValInput, setHeaderValInput] = useState('');
  const [copiedSql, setCopiedSql] = useState(false);

  const toggleSection = (id: AccordionSectionId) => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const activeProvider = providers.find((p) => p.id === selectedProviderId) ?? providers[0];

  const updateActiveProvider = (patch: Partial<ProviderEndpoint>) => {
    if (!activeProvider) return;
    onProvidersChange(
      providers.map((p) => (p.id === activeProvider.id ? { ...p, ...patch } : p))
    );
  };

  const handleAddTargetModel = (provider: ProviderEndpoint, modelName: string) => {
    const clean = modelName.trim();
    if (!clean) return;
    const exists = targets.some(
      (t) => t.providerId === provider.id && t.modelName === clean
    );
    if (!exists) {
      onTargetsChange([
        ...targets,
        {
          id: `target-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          providerId: provider.id,
          providerName: provider.name,
          providerKind: provider.kind,
          modelName: clean,
          enabled: true,
        },
      ]);
    }
    if (!provider.models.includes(clean)) {
      updateActiveProvider({ models: [...provider.models, clean] });
    }
    setNewModelInput('');
  };

  const handleDiscoverModels = async () => {
    if (!activeProvider || activeProvider.kind === 'gemini-builtin') return;
    setDiscoverStatus('Discovering models...');
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...activeProvider.customHeaders,
      };
      let res: Response;
      if (activeProvider.directBrowser) {
        if (activeProvider.apiKey && !headers['Authorization']) {
          headers['Authorization'] = `Bearer ${activeProvider.apiKey}`;
        }
        res = await fetch(`${activeProvider.baseUrl.replace(/\/+$/, '')}/models`, {
          headers,
        });
      } else {
        res = await fetch('/api/proxy/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: activeProvider.baseUrl,
            apiKey: activeProvider.apiKey,
            headers: activeProvider.customHeaders,
          }),
        });
      }
      const data = (await res.json()) as {
        data?: Array<{ id: string }>;
        models?: Array<{ name?: string; id?: string }>;
        error?: string;
      };
      if (!res.ok) {
        setDiscoverStatus(data.error || `Discovery failed (${res.status})`);
        return;
      }
      const found =
        data.data?.map((m) => m.id) ??
        data.models?.map((m) => m.id || m.name || '').filter(Boolean) ??
        [];
      if (found.length === 0) {
        setDiscoverStatus('No models returned from /models.');
      } else {
        const merged = Array.from(new Set([...activeProvider.models, ...found]));
        updateActiveProvider({ models: merged });
        setDiscoverStatus(`Discovered ${found.length} models.`);
      }
    } catch (err: unknown) {
      const errObj = err as { message?: string };
      setDiscoverStatus(errObj?.message || 'Unable to reach /models');
    }
  };

  const handleAddProviderPreset = (tpl: (typeof PROVIDER_TEMPLATES)[number]) => {
    const newId = `provider-${tpl.kind}-${Date.now().toString(36)}`;
    const created: ProviderEndpoint = {
      id: newId,
      name: `${tpl.label} Endpoint`,
      kind: tpl.kind,
      baseUrl: tpl.baseUrl,
      apiKey: '',
      customHeaders: {},
      directBrowser: tpl.directBrowser,
      models: [tpl.defaultModel],
    };
    onProvidersChange([...providers, created]);
    setSelectedProviderId(newId);
  };

  const filteredSuitePrompts = PROMPT_SUITES.filter((s) => s.suite === suiteTab);

  return (
    <div className="h-full flex flex-col divide-y overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
      {/* SECTION 1: PROMPT & SUITES (Open by default) */}
      <section style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          onClick={() => toggleSection('prompt')}
          aria-expanded={openSections.prompt}
          className="w-full px-4 py-3 flex items-center justify-between text-left text-sm font-semibold font-display cursor-pointer transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          <span>Prompt & Test Suites</span>
          {openSections.prompt ? (
            <ChevronDown className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          ) : (
            <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          )}
        </button>

        {openSections.prompt && (
          <div className="px-4 pb-4 space-y-4">
            {/* Prompt Input */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="workbench-prompt-input" className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                  Evaluation Prompt
                </label>
                <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {prompt.length} chars
                </span>
              </div>
              <textarea
                id="workbench-prompt-input"
                value={prompt}
                onChange={(e) => onPromptChange(e.target.value)}
                rows={5}
                placeholder="Enter a prompt or pick a benchmark from the suites below..."
                className="w-full rounded-lg border p-2.5 text-xs leading-relaxed resize-y focus:outline-none focus-visible:ring-2"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-canvas)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            {/* System Prompt Layer */}
            <div
              className="rounded-lg border p-3 space-y-2.5"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                  <input
                    type="checkbox"
                    checked={systemPrompt.enabled}
                    onChange={(e) =>
                      onSystemPromptChange({ ...systemPrompt, enabled: e.target.checked })
                    }
                    className="rounded"
                  />
                  <span>System Prompt Layer</span>
                </label>

                <select
                  aria-label="System prompt targeting mode"
                  value={systemPrompt.targetMode}
                  onChange={(e) =>
                    onSystemPromptChange({
                      ...systemPrompt,
                      targetMode: e.target.value as 'all' | 'specific',
                    })
                  }
                  className="px-2 py-1 rounded border text-[11px]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="all">All Models</option>
                  <option value="specific">Specific Models</option>
                </select>
              </div>

              {/* Built-in Personas */}
              <div className="flex flex-wrap gap-1.5">
                {SYSTEM_PERSONAS.map((persona) => {
                  const active = systemPrompt.personaId === persona.id && systemPrompt.enabled;
                  return (
                    <button
                      key={persona.id}
                      type="button"
                      onClick={() =>
                        onSystemPromptChange({
                          ...systemPrompt,
                          enabled: true,
                          personaId: persona.id,
                          content: persona.prompt,
                        })
                      }
                      title={persona.description}
                      className="px-2 py-1 rounded border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      style={{
                        borderColor: active ? 'var(--accent-primary)' : 'var(--border-subtle)',
                        backgroundColor: active ? 'var(--accent-soft)' : 'var(--bg-surface)',
                        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {persona.name}
                    </button>
                  );
                })}
              </div>

              {systemPrompt.enabled && (
                <>
                  <textarea
                    value={systemPrompt.content}
                    onChange={(e) =>
                      onSystemPromptChange({
                        ...systemPrompt,
                        personaId: null,
                        content: e.target.value,
                      })
                    }
                    rows={3}
                    placeholder="Enter custom system instructions..."
                    className="w-full rounded border p-2 text-xs leading-relaxed resize-y"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                    }}
                  />

                  {systemPrompt.targetMode === 'specific' && (
                    <div className="space-y-1 pt-1">
                      <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                        Apply system directive to:
                      </div>
                      <div className="max-h-24 overflow-y-auto space-y-1">
                        {targets.map((t) => {
                          const checked = systemPrompt.targetModelIds.includes(t.id);
                          return (
                            <label
                              key={t.id}
                              className="flex items-center gap-2 text-xs cursor-pointer"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const nextIds = e.target.checked
                                    ? [...systemPrompt.targetModelIds, t.id]
                                    : systemPrompt.targetModelIds.filter((id) => id !== t.id);
                                  onSystemPromptChange({
                                    ...systemPrompt,
                                    targetModelIds: nextIds,
                                  });
                                }}
                              />
                              <span className="truncate font-mono text-[11px]">{t.modelName}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Prompt Test Suites */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                <span>Prompt Test Suites</span>
              </div>

              <div
                className="grid grid-cols-3 gap-1 p-1 rounded-lg border"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
              >
                <button
                  type="button"
                  onClick={() => setSuiteTab('nerdy-kings')}
                  className="px-2 py-1 rounded text-[11px] font-medium cursor-pointer truncate"
                  style={{
                    backgroundColor: suiteTab === 'nerdy-kings' ? 'var(--bg-surface)' : 'transparent',
                    color: suiteTab === 'nerdy-kings' ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  Nerdy Kings (18)
                </button>
                <button
                  type="button"
                  onClick={() => setSuiteTab('html-games')}
                  className="px-2 py-1 rounded text-[11px] font-medium cursor-pointer truncate"
                  style={{
                    backgroundColor: suiteTab === 'html-games' ? 'var(--bg-surface)' : 'transparent',
                    color: suiteTab === 'html-games' ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  HTML Games (4)
                </button>
                <button
                  type="button"
                  onClick={() => setSuiteTab('classic-benchmarks')}
                  className="px-2 py-1 rounded text-[11px] font-medium cursor-pointer truncate"
                  style={{
                    backgroundColor:
                      suiteTab === 'classic-benchmarks' ? 'var(--bg-surface)' : 'transparent',
                    color:
                      suiteTab === 'classic-benchmarks' ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  Classic (4)
                </button>
              </div>

              <div
                className="max-h-56 overflow-y-auto rounded-lg border divide-y"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
              >
                {filteredSuitePrompts.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectSuitePrompt(item.prompt, item.title, item.suiteLabel)}
                    className="w-full px-3 py-2 text-left transition-colors hover:opacity-90 cursor-pointer flex items-start justify-between gap-2"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {String(item.index).padStart(2, '0')}. {item.title}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                        {item.category}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* SECTION 2: CONFIGURATION (Collapsed by default) */}
      <section style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          onClick={() => toggleSection('config')}
          aria-expanded={openSections.config}
          className="w-full px-4 py-3 flex items-center justify-between text-left text-sm font-semibold font-display cursor-pointer transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          <span>Configuration & Models</span>
          {openSections.config ? (
            <ChevronDown className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          ) : (
            <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          )}
        </button>

        {openSections.config && (
          <div className="px-4 pb-4 space-y-4">
            {/* Execution Engine Parameters */}
            <div
              className="rounded-lg border p-3 space-y-3"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                Execution Engine
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onExecutionConfigChange({ ...executionConfig, mode: 'parallel' })
                  }
                  className="px-2.5 py-1.5 rounded border text-xs font-medium cursor-pointer"
                  style={{
                    borderColor:
                      executionConfig.mode === 'parallel'
                        ? 'var(--accent-primary)'
                        : 'var(--border-subtle)',
                    backgroundColor:
                      executionConfig.mode === 'parallel'
                        ? 'var(--accent-soft)'
                        : 'var(--bg-surface)',
                    color:
                      executionConfig.mode === 'parallel'
                        ? 'var(--accent-primary)'
                        : 'var(--text-secondary)',
                  }}
                >
                  Parallel Pool
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onExecutionConfigChange({ ...executionConfig, mode: 'sequential' })
                  }
                  className="px-2.5 py-1.5 rounded border text-xs font-medium cursor-pointer"
                  style={{
                    borderColor:
                      executionConfig.mode === 'sequential'
                        ? 'var(--accent-primary)'
                        : 'var(--border-subtle)',
                    backgroundColor:
                      executionConfig.mode === 'sequential'
                        ? 'var(--accent-soft)'
                        : 'var(--bg-surface)',
                    color:
                      executionConfig.mode === 'sequential'
                        ? 'var(--accent-primary)'
                        : 'var(--text-secondary)',
                  }}
                >
                  Sequential
                </button>
              </div>

              {executionConfig.mode === 'parallel' && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-secondary)' }}>Concurrent Workers</span>
                    <span className="font-mono tabular-nums" style={{ color: 'var(--text-primary)' }}>
                      {executionConfig.concurrency} threads
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={executionConfig.concurrency}
                    onChange={(e) =>
                      onExecutionConfigChange({
                        ...executionConfig,
                        concurrency: Number(e.target.value),
                      })
                    }
                    className="w-full"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>Timeout (sec)</span>
                  <input
                    type="number"
                    min={5}
                    max={600}
                    value={executionConfig.timeoutSec}
                    onChange={(e) =>
                      onExecutionConfigChange({
                        ...executionConfig,
                        timeoutSec: Number(e.target.value) || 300,
                      })
                    }
                    className="w-full px-2 py-1 rounded border font-mono"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>

                <label className="space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>Temperature</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={executionConfig.temperature}
                    onChange={(e) =>
                      onExecutionConfigChange({
                        ...executionConfig,
                        temperature: Number(e.target.value),
                      })
                    }
                    className="w-full px-2 py-1 rounded border font-mono"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>

                <label className="space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>Max Tokens</span>
                  <input
                    type="number"
                    min={0}
                    max={128000}
                    value={executionConfig.maxTokens}
                    onChange={(e) =>
                      onExecutionConfigChange({
                        ...executionConfig,
                        maxTokens: Number(e.target.value) || 0,
                      })
                    }
                    className="w-full px-2 py-1 rounded border font-mono"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>

                <label className="flex items-center gap-2 pt-5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={executionConfig.stream}
                    onChange={(e) =>
                      onExecutionConfigChange({ ...executionConfig, stream: e.target.checked })
                    }
                  />
                  <span>SSE Stream</span>
                </label>
              </div>
            </div>

            {/* Active Target Models */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                <span>Benchmark Target Models</span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {targets.filter((t) => t.enabled).length}/{targets.length} active
                </span>
              </div>

              <div
                className="rounded-lg border divide-y max-h-48 overflow-y-auto"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
              >
                {targets.map((target) => (
                  <div
                    key={target.id}
                    className="px-2.5 py-2 flex items-center justify-between gap-2 text-xs"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <label className="flex items-center gap-2 min-w-0 cursor-pointer flex-1">
                      <input
                        type="checkbox"
                        checked={target.enabled}
                        onChange={(e) =>
                          onTargetsChange(
                            targets.map((t) =>
                              t.id === target.id ? { ...t, enabled: e.target.checked } : t
                            )
                          )
                        }
                      />
                      <div className="min-w-0">
                        <div className="font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                          {target.modelName}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {target.providerName}
                        </div>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => onTargetsChange(targets.filter((t) => t.id !== target.id))}
                      aria-label={`Remove ${target.modelName}`}
                      className="p-1 opacity-60 hover:opacity-100 cursor-pointer"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Provider Endpoint Editor */}
            <div
              className="rounded-lg border p-3 space-y-3"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
            >
              <div className="flex items-center justify-between">
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <Server className="w-3.5 h-3.5" />
                  <span>Provider Endpoints</span>
                </div>
              </div>

              {/* Quick Add Presets */}
              <div className="flex flex-wrap gap-1">
                {PROVIDER_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.kind}
                    type="button"
                    onClick={() => handleAddProviderPreset(tpl)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] cursor-pointer"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Plus className="w-2.5 h-2.5" />
                    <span>{tpl.label}</span>
                  </button>
                ))}
              </div>

              <select
                aria-label="Select provider endpoint"
                value={activeProvider?.id ?? ''}
                onChange={(e) => {
                  setSelectedProviderId(e.target.value);
                  setDiscoverStatus(null);
                }}
                className="w-full px-2.5 py-1.5 rounded border text-xs"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.kind})
                  </option>
                ))}
              </select>

              {activeProvider && (
                <div className="space-y-2.5 text-xs">
                  {activeProvider.kind !== 'gemini-builtin' ? (
                    <>
                      <label className="block space-y-1">
                        <span style={{ color: 'var(--text-muted)' }}>Base URL (OpenAI /v1)</span>
                        <input
                          type="text"
                          value={activeProvider.baseUrl}
                          onChange={(e) => updateActiveProvider({ baseUrl: e.target.value })}
                          className="w-full px-2 py-1.5 rounded border font-mono text-[11px]"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            backgroundColor: 'var(--bg-surface)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>

                      <label className="block space-y-1">
                        <span style={{ color: 'var(--text-muted)' }}>Bearer Token / Secret Header (optional)</span>
                        <input
                          type="password"
                          value={activeProvider.apiKey}
                          onChange={(e) => updateActiveProvider({ apiKey: e.target.value })}
                          placeholder="sk-... or leave blank for Ollama"
                          className="w-full px-2 py-1.5 rounded border font-mono text-[11px]"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            backgroundColor: 'var(--bg-surface)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </label>

                      <label className="flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                        <input
                          type="checkbox"
                          checked={activeProvider.directBrowser}
                          onChange={(e) =>
                            updateActiveProvider({ directBrowser: e.target.checked })
                          }
                        />
                        <span>Direct Browser Mode (for localhost Ollama / LM Studio)</span>
                      </label>

                      {/* Custom Headers */}
                      <div className="space-y-1">
                        <span style={{ color: 'var(--text-muted)' }}>Custom Headers</span>
                        <div className="flex gap-1">
                          <input
                            type="text"
                            placeholder="Header Name"
                            value={headerKeyInput}
                            onChange={(e) => setHeaderKeyInput(e.target.value)}
                            className="w-1/2 px-2 py-1 rounded border text-[11px] font-mono"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              backgroundColor: 'var(--bg-surface)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <input
                            type="text"
                            placeholder="Value"
                            value={headerValInput}
                            onChange={(e) => setHeaderValInput(e.target.value)}
                            className="w-1/2 px-2 py-1 rounded border text-[11px] font-mono"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              backgroundColor: 'var(--bg-surface)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (!headerKeyInput.trim()) return;
                              updateActiveProvider({
                                customHeaders: {
                                  ...activeProvider.customHeaders,
                                  [headerKeyInput.trim()]: headerValInput,
                                },
                              });
                              setHeaderKeyInput('');
                              setHeaderValInput('');
                            }}
                            className="px-2 py-1 rounded border text-[11px] cursor-pointer"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              backgroundColor: 'var(--bg-surface)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            Add
                          </button>
                        </div>
                        {Object.entries(activeProvider.customHeaders).map(([k, v]) => (
                          <div key={k} className="flex items-center justify-between text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                            <span className="truncate">{k}: {v ? '••••' : '(empty)'}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const copy = { ...activeProvider.customHeaders };
                                delete copy[k];
                                updateActiveProvider({ customHeaders: copy });
                              }}
                              className="text-red-500 cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={handleDiscoverModels}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            backgroundColor: 'var(--bg-surface)',
                            color: 'var(--text-primary)',
                          }}
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>Discover Models</span>
                        </button>
                        {discoverStatus && (
                          <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {discoverStatus}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Server-managed Gemini SSE adapter using environment credentials. Add models below to benchmark concurrently.
                    </p>
                  )}

                  {/* Add model to active targets */}
                  <div className="flex gap-1.5 pt-1">
                    <input
                      type="text"
                      value={newModelInput}
                      onChange={(e) => setNewModelInput(e.target.value)}
                      placeholder="Add model ID (e.g. llama3.2:latest)"
                      className="flex-1 px-2 py-1 rounded border font-mono text-[11px]"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleAddTargetModel(activeProvider, newModelInput)}
                      className="px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap shrink-0"
                      style={{
                        backgroundColor: 'var(--accent-primary)',
                        color: 'var(--accent-contrast)',
                      }}
                    >
                      Add Target
                    </button>
                  </div>

                  {/* Quick model chips for provider */}
                  {activeProvider.models.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {activeProvider.models.map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => handleAddTargetModel(activeProvider, m)}
                          className="px-2 py-0.5 rounded border text-[11px] font-mono cursor-pointer hover:opacity-80"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            backgroundColor: 'var(--bg-surface)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          + {m}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* SECTION 3: HISTORY & SUPABASE CLOUD SYNC (Collapsed by default) */}
      <section style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          onClick={() => toggleSection('history')}
          aria-expanded={openSections.history}
          className="w-full px-4 py-3 flex items-center justify-between text-left text-sm font-semibold font-display cursor-pointer transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          <span>History & Cloud Sync</span>
          {openSections.history ? (
            <ChevronDown className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          ) : (
            <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          )}
        </button>

        {openSections.history && (
          <div className="px-4 pb-4 space-y-4">
            {/* Local History (last 50 runs) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <Database className="w-3.5 h-3.5" />
                  <span>Local Runs ({history.length}/50)</span>
                </span>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={onClearHistory}
                    className="text-[11px] hover:underline cursor-pointer"
                    style={{ color: 'var(--status-error)' }}
                  >
                    Clear All
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  No saved runs yet. Completed benchmarks are automatically persisted in localStorage.
                </p>
              ) : (
                <div
                  className="max-h-48 overflow-y-auto rounded-lg border divide-y"
                  style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-canvas)' }}
                >
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="px-3 py-2 flex items-center justify-between gap-2 text-xs"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <button
                        type="button"
                        onClick={() => onLoadHistoryRun(item)}
                        className="text-left min-w-0 flex-1 cursor-pointer hover:opacity-80"
                      >
                        <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {item.title}
                        </div>
                        <div className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                          {item.results.length} models · {new Date(item.createdAt).toLocaleTimeString()}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteHistoryRun(item.id)}
                        aria-label={`Delete run ${item.title}`}
                        className="p-1 opacity-60 hover:opacity-100 cursor-pointer"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Supabase Cloud Sync */}
            <div
              className="rounded-lg border p-3 space-y-2.5 text-xs"
              style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <Cloud className="w-3.5 h-3.5" />
                  <span>Supabase PostgreSQL Sync</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(SUPABASE_TABLE_SQL).catch(() => {});
                    setCopiedSql(true);
                    setTimeout(() => setCopiedSql(false), 1500);
                  }}
                  className="text-[11px] underline cursor-pointer"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  {copiedSql ? 'SQL Copied' : 'Copy Table SQL'}
                </button>
              </div>

              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Supabase Project URL</span>
                <input
                  type="url"
                  value={supabaseConfig.url}
                  onChange={(e) =>
                    onSupabaseConfigChange({ ...supabaseConfig, url: e.target.value })
                  }
                  placeholder="https://xyz.supabase.co"
                  className="w-full px-2 py-1.5 rounded border font-mono text-[11px]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>

              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Anon / Service Key</span>
                <input
                  type="password"
                  value={supabaseConfig.anonKey}
                  onChange={(e) =>
                    onSupabaseConfigChange({ ...supabaseConfig, anonKey: e.target.value })
                  }
                  placeholder="eyJ..."
                  className="w-full px-2 py-1.5 rounded border font-mono text-[11px]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>

              <label className="flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={supabaseConfig.autoSync}
                  onChange={(e) =>
                    onSupabaseConfigChange({ ...supabaseConfig, autoSync: e.target.checked })
                  }
                />
                <span>Auto-sync runs on completion</span>
              </label>

              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={onTestSupabase}
                  disabled={isSyncing}
                  className="px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  Test Connection
                </button>
                <button
                  type="button"
                  onClick={onPushSupabase}
                  disabled={isSyncing}
                  className="px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  Push Run
                </button>
                <button
                  type="button"
                  onClick={onPullSupabase}
                  disabled={isSyncing}
                  className="px-2.5 py-1 rounded border text-[11px] font-medium cursor-pointer disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  Pull Runs
                </button>
              </div>

              {/* Sync Log Monitor */}
              <div className="space-y-1 pt-1">
                <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  Sync Log Monitor
                </div>
                <div
                  className="max-h-28 overflow-y-auto rounded border p-2 font-mono text-[11px] space-y-1"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-canvas)',
                  }}
                >
                  {syncLogs.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>No sync events logged.</span>
                  ) : (
                    syncLogs.map((log) => (
                      <div
                        key={log.id}
                        style={{
                          color:
                            log.status === 'success'
                              ? 'var(--status-success)'
                              : 'var(--status-error)',
                        }}
                      >
                        [{new Date(log.timestamp).toLocaleTimeString()}] {log.action.toUpperCase()}:{' '}
                        {log.message}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

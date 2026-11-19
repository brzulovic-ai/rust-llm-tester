import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
} from 'lucide-react';
import { SYSTEM_PERSONAS } from '../data/promptSuites';
import type {
  ChatTurnMessage,
  CustomSendParam,
  EndpointFileAttachment,
  EndpointPayloadMode,
  EndpointType,
  ExecutionConfig,
  ModelRunResult,
  ProviderEndpoint,
  SendParamActivation,
  SystemPromptConfig,
  TargetModel,
} from '../types/benchmark';
import { ENDPOINT_PRESETS, filesForEndpoint } from '../utils/endpointUtils';
import { resolveSystemPromptForTarget } from '../utils/executionEngine';
import { classifyResultStatus, formatMs } from '../utils/metrics';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ChatViewProps {
  targets: TargetModel[];
  onTargetsChange: (next: TargetModel[]) => void;
  providers: ProviderEndpoint[];
  onProvidersChange: (next: ProviderEndpoint[]) => void;
  executionConfig: ExecutionConfig;
  onExecutionConfigChange: (next: ExecutionConfig) => void;
  systemPrompt: SystemPromptConfig;
  onSystemPromptChange: (next: SystemPromptConfig) => void;
  endpointFiles: EndpointFileAttachment[];
  onEndpointFilesChange: (next: EndpointFileAttachment[]) => void;
  activeTargetId: string;
  onActiveTargetIdChange: (id: string) => void;
  messages: ChatTurnMessage[];
  chatInput: string;
  onChatInputChange: (val: string) => void;
  isRunning: boolean;
  lastResult: ModelRunResult | null;
  onSendTurn: () => void;
  onAbort: () => void;
  onResetChat: () => void;
}

function formatCustomHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

function parseCustomHeaders(raw: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const k = trimmed.slice(0, colonIdx).trim();
    const v = trimmed.slice(colonIdx + 1).trim();
    if (k) next[k] = v;
  }
  return next;
}

export const ChatView: React.FC<ChatViewProps> = ({
  targets,
  onTargetsChange,
  providers,
  onProvidersChange,
  executionConfig,
  onExecutionConfigChange,
  systemPrompt,
  onSystemPromptChange,
  endpointFiles,
  onEndpointFilesChange,
  activeTargetId,
  onActiveTargetIdChange,
  messages,
  chatInput,
  onChatInputChange,
  isRunning,
  lastResult,
  onSendTurn,
  onAbort,
  onResetChat,
}) => {
  const configScrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [newParamKey, setNewParamKey] = useState('');
  const [newParamValue, setNewParamValue] = useState('');

  const activeTarget = useMemo(
    () =>
      targets.find((t) => t.id === activeTargetId) ??
      targets.find((t) => t.enabled) ??
      targets[0] ??
      null,
    [targets, activeTargetId]
  );

  const activeProvider = useMemo(
    () =>
      activeTarget
        ? providers.find((p) => p.id === activeTarget.providerId) ?? providers[0] ?? null
        : providers[0] ?? null,
    [activeTarget, providers]
  );

  const [headersDraft, setHeadersDraft] = useState(() =>
    activeProvider ? formatCustomHeaders(activeProvider.customHeaders) : ''
  );

  useEffect(() => {
    setHeadersDraft(activeProvider ? formatCustomHeaders(activeProvider.customHeaders) : '');
  }, [activeProvider?.id]);

  // Keyboard scrolling helpers for config panel & transcript canvas (PageUp/Down & Shift+Up/Down)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      const tag = targetEl?.tagName;
      const isEditingText =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || targetEl?.isContentEditable;

      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const delta = e.key === 'ArrowDown' ? 160 : -160;
        const insideConfig = configScrollRef.current && targetEl && configScrollRef.current.contains(targetEl);
        const container = insideConfig ? configScrollRef.current : transcriptScrollRef.current;
        if (!container) return;
        e.preventDefault();
        if (typeof container.scrollBy === 'function') {
          container.scrollBy({ top: delta, behavior: 'auto' });
        } else {
          container.scrollTop = Math.max(0, container.scrollTop + delta);
        }
        return;
      }

      if (!isEditingText && (e.key === 'PageUp' || e.key === 'PageDown')) {
        const container = transcriptScrollRef.current;
        if (!container) return;
        e.preventDefault();
        const delta = e.key === 'PageDown' ? 240 : -240;
        if (typeof container.scrollBy === 'function') {
          container.scrollBy({ top: delta, behavior: 'auto' });
        } else {
          container.scrollTop = Math.max(0, container.scrollTop + delta);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const updateProvider = (patch: Partial<ProviderEndpoint>) => {
    if (!activeProvider) return;
    onProvidersChange(
      providers.map((p) => (p.id === activeProvider.id ? { ...p, ...patch } : p))
    );
    if (patch.name !== undefined) {
      onTargetsChange(
        targets.map((t) =>
          t.providerId === activeProvider.id ? { ...t, providerName: patch.name! } : t
        )
      );
    }
  };

  const updateActiveTarget = (patch: Partial<TargetModel>) => {
    if (!activeTarget) return;
    onTargetsChange(
      targets.map((t) => (t.id === activeTarget.id ? { ...t, ...patch } : t))
    );
  };

  const activeParams = executionConfig.activeParams ?? {};
  const isParamActive = (key: keyof SendParamActivation): boolean =>
    activeParams[key] !== false;

  const setParamActive = (key: keyof SendParamActivation, enabled: boolean) => {
    onExecutionConfigChange({
      ...executionConfig,
      activeParams: {
        ...activeParams,
        [key]: enabled,
      },
    });
  };

  const extraParams = executionConfig.extraParams ?? [];

  const handleAddParam = () => {
    const cleanedKey = newParamKey.trim() || `param_${extraParams.length + 1}`;
    const cleanedVal = newParamValue.trim() || 'true';
    const nextItem: CustomSendParam = {
      id: `extra-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      key: cleanedKey,
      value: cleanedVal,
      enabled: true,
    };
    onExecutionConfigChange({
      ...executionConfig,
      extraParams: [...extraParams, nextItem],
    });
    setNewParamKey('');
    setNewParamValue('');
  };

  const updateExtraParam = (id: string, patch: Partial<CustomSendParam>) => {
    onExecutionConfigChange({
      ...executionConfig,
      extraParams: extraParams.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const removeExtraParam = (id: string) => {
    onExecutionConfigChange({
      ...executionConfig,
      extraParams: extraParams.filter((p) => p.id !== id),
    });
  };

  const scrollConfigBy = (delta: number) => {
    const el = configScrollRef.current;
    if (!el) return;
    if (typeof el.scrollBy === 'function') {
      el.scrollBy({ top: delta, behavior: 'smooth' });
    } else {
      el.scrollTop = Math.max(0, el.scrollTop + delta);
    }
  };

  const activeEndpointType: EndpointType = executionConfig.endpointType ?? 'chat-completions';
  const activeFiles = filesForEndpoint(endpointFiles, activeEndpointType);
  const resolvedSystemPrompt = activeTarget
    ? resolveSystemPromptForTarget(activeTarget, systemPrompt)
    : undefined;

  const statusBadge = lastResult ? classifyResultStatus(lastResult) : null;

  return (
    <div
      data-testid="chat-view"
      className="h-full min-h-[520px] grid grid-cols-1 lg:grid-cols-12 gap-4"
    >
      {/* Left Pane: All Editable Send Config Values (Scrollable) */}
      <section
        className="lg:col-span-5 rounded-xl border flex flex-col overflow-hidden min-h-0"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        <div
          className="px-4 py-2.5 border-b flex items-center justify-between gap-2 shrink-0"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
            <h2 className="text-xs font-semibold font-display truncate" style={{ color: 'var(--text-primary)' }}>
              Chat · Editable Send Config
            </h2>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleAddParam}
              title="Add a custom JSON send parameter"
              className="inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium cursor-pointer hover:opacity-90"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--accent-primary)',
              }}
            >
              <Plus className="w-3 h-3" />
              <span>Add Param</span>
            </button>
            <button
              type="button"
              aria-label="Scroll send config up"
              title="Scroll config up"
              onClick={() => scrollConfigBy(-180)}
              className="p-1 rounded border cursor-pointer hover:opacity-80"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              aria-label="Scroll send config down"
              title="Scroll config down"
              onClick={() => scrollConfigBy(180)}
              className="p-1 rounded border cursor-pointer hover:opacity-80"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div
          ref={configScrollRef}
          data-testid="chat-config-panel"
          className="flex-1 overflow-y-auto p-4 space-y-4 text-xs"
        >
          {/* Target & Provider Selection */}
          <div
            className="rounded-lg border p-3 space-y-2.5"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-primary)' }}>
              Target & Provider
            </div>

            <label className="block space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Target Model</span>
              <select
                aria-label="Chat target model"
                value={activeTarget?.id ?? ''}
                onChange={(e) => onActiveTargetIdChange(e.target.value)}
                className="w-full px-2 py-1.5 rounded border text-xs font-mono"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.modelName} @ {t.providerName} {t.enabled ? '' : '(disabled)'}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Editable Model ID</span>
              <input
                type="text"
                aria-label="Editable target model ID"
                value={activeTarget?.modelName ?? ''}
                onChange={(e) => updateActiveTarget({ modelName: e.target.value })}
                className="w-full px-2 py-1.5 rounded border text-xs font-mono"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>

            {activeProvider && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="block space-y-1">
                    <span style={{ color: 'var(--text-muted)' }}>Switch Provider</span>
                    <select
                      aria-label="Chat provider selector"
                      value={activeProvider.id}
                      onChange={(e) => {
                        const nextProvId = e.target.value;
                        const firstTarget = targets.find((t) => t.providerId === nextProvId);
                        if (firstTarget) {
                          onActiveTargetIdChange(firstTarget.id);
                        }
                      }}
                      className="w-full px-2 py-1.5 rounded border text-xs"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span style={{ color: 'var(--text-muted)' }}>Provider Name</span>
                    <input
                      type="text"
                      aria-label="Chat provider name"
                      value={activeProvider.name}
                      onChange={(e) => updateProvider({ name: e.target.value })}
                      className="w-full px-2 py-1.5 rounded border text-xs"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </label>
                </div>

                <label className="block space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>Base URL</span>
                  <input
                    type="text"
                    aria-label="Chat provider base URL"
                    value={activeProvider.baseUrl}
                    disabled={activeProvider.kind === 'gemini-builtin'}
                    onChange={(e) => updateProvider({ baseUrl: e.target.value })}
                    className="w-full px-2 py-1.5 rounded border text-xs font-mono disabled:opacity-50"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </label>

                <div className="space-y-1">
                  <span style={{ color: 'var(--text-muted)' }}>API Key</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      aria-label="Chat provider API key"
                      value={activeProvider.apiKey}
                      disabled={activeProvider.kind === 'gemini-builtin'}
                      placeholder={activeProvider.kind === 'gemini-builtin' ? 'Server GEMINI_API_KEY' : 'sk-...'}
                      onChange={(e) => updateProvider({ apiKey: e.target.value })}
                      className="flex-1 px-2 py-1.5 rounded border text-xs font-mono disabled:opacity-50"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <button
                      type="button"
                      aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="p-1.5 rounded border cursor-pointer"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className={`space-y-1 ${isParamActive('customHeaders') ? '' : 'opacity-60'}`}>
                  <label className="inline-flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      aria-label="Activate Custom Headers param"
                      checked={isParamActive('customHeaders')}
                      onChange={(e) => setParamActive('customHeaders', e.target.checked)}
                    />
                    <span>Custom Headers (Key: Value; Key2: Value2)</span>
                  </label>
                  <input
                    type="text"
                    aria-label="Chat custom headers"
                    value={headersDraft}
                    disabled={activeProvider.kind === 'gemini-builtin'}
                    placeholder="X-Title: BenchForge; HTTP-Referer: http://localhost:3000"
                    onChange={(e) => {
                      const val = e.target.value;
                      setHeadersDraft(val);
                      updateProvider({ customHeaders: parseCustomHeaders(val) });
                    }}
                    className="w-full px-2 py-1.5 rounded border text-xs font-mono disabled:opacity-50"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <label className="flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    aria-label="Chat direct browser CORS mode"
                    checked={activeProvider.directBrowser}
                    disabled={activeProvider.kind === 'gemini-builtin'}
                    onChange={(e) => updateProvider({ directBrowser: e.target.checked })}
                  />
                  <span>Direct Browser Mode (bypass /api/proxy)</span>
                </label>
              </>
            )}
          </div>

          {/* Endpoint & Sampling Send Values (each with Activate checkbox before sending) */}
          <div
            className="rounded-lg border p-3 space-y-2.5"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-primary)' }}>
              Endpoint & Sampling Parameters (Check to Send)
            </div>

            <label className="block space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Endpoint Type</span>
              <select
                aria-label="Chat endpoint type"
                value={activeEndpointType}
                onChange={(e) =>
                  onExecutionConfigChange({
                    ...executionConfig,
                    endpointType: e.target.value as EndpointType,
                  })
                }
                className="w-full px-2 py-1.5 rounded border text-xs"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              >
                {ENDPOINT_PRESETS.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.label} ({ep.pathLabel})
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className={`space-y-1 ${isParamActive('customEndpoint') ? '' : 'opacity-60'}`}>
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate Custom Endpoint param"
                    checked={isParamActive('customEndpoint')}
                    onChange={(e) => setParamActive('customEndpoint', e.target.checked)}
                  />
                  <span>Custom Endpoint</span>
                </label>
                <input
                  type="text"
                  aria-label="Chat custom endpoint"
                  value={executionConfig.customEndpoint ?? ''}
                  placeholder="/v1/chat/completions"
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      customEndpoint: e.target.value,
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Payload Mode</span>
                <select
                  aria-label="Chat payload mode"
                  value={executionConfig.customPayloadMode ?? 'auto'}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      customPayloadMode: e.target.value as EndpointPayloadMode,
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="auto">Auto</option>
                  <option value="json">JSON Body</option>
                  <option value="multipart">Multipart FormData</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className={`space-y-1 ${isParamActive('temperature') ? '' : 'opacity-60'}`}>
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate Temperature param"
                    checked={isParamActive('temperature')}
                    onChange={(e) => setParamActive('temperature', e.target.checked)}
                  />
                  <span>Temperature</span>
                </label>
                <input
                  type="number"
                  aria-label="Chat temperature"
                  step={0.05}
                  min={0}
                  max={2}
                  value={executionConfig.temperature}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    onExecutionConfigChange({
                      ...executionConfig,
                      temperature: Number.isFinite(num) ? Math.min(Math.max(num, 0), 2) : 0.7,
                    });
                  }}
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono tabular-nums"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className={`space-y-1 ${isParamActive('topP') ? '' : 'opacity-60'}`}>
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate Top P param"
                    checked={isParamActive('topP')}
                    onChange={(e) => setParamActive('topP', e.target.checked)}
                  />
                  <span>Top P</span>
                </label>
                <input
                  type="number"
                  aria-label="Chat top_p"
                  step={0.05}
                  min={0}
                  max={1}
                  value={executionConfig.topP}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    onExecutionConfigChange({
                      ...executionConfig,
                      topP: Number.isFinite(num) ? Math.min(Math.max(num, 0), 1) : 1,
                    });
                  }}
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono tabular-nums"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className={`space-y-1 ${isParamActive('maxTokens') ? '' : 'opacity-60'}`}>
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate Max Tokens param"
                    checked={isParamActive('maxTokens')}
                    onChange={(e) => setParamActive('maxTokens', e.target.checked)}
                  />
                  <span>Max Tokens</span>
                </label>
                <input
                  type="number"
                  aria-label="Chat max tokens"
                  min={0}
                  max={128000}
                  value={executionConfig.maxTokens}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      maxTokens: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono tabular-nums"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Timeout (sec)</span>
                <input
                  type="number"
                  aria-label="Chat timeout sec"
                  min={5}
                  max={600}
                  value={executionConfig.timeoutSec}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      timeoutSec: Math.min(Math.max(Number(e.target.value) || 300, 5), 600),
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono tabular-nums"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>

              <div className={`space-y-1 ${isParamActive('seed') ? '' : 'opacity-60'}`}>
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate Seed param"
                    checked={isParamActive('seed')}
                    onChange={(e) => setParamActive('seed', e.target.checked)}
                  />
                  <span>Seed</span>
                </label>
                <input
                  type="number"
                  aria-label="Chat seed"
                  value={executionConfig.seed ?? ''}
                  placeholder="none"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    onExecutionConfigChange({
                      ...executionConfig,
                      seed: raw === '' ? undefined : Math.trunc(Number(raw)),
                    });
                  }}
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono tabular-nums"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className={`space-y-1 ${isParamActive('ttsVoice') ? '' : 'opacity-60'}`}>
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate TTS Voice param"
                    checked={isParamActive('ttsVoice')}
                    onChange={(e) => setParamActive('ttsVoice', e.target.checked)}
                  />
                  <span>TTS Voice</span>
                </label>
                <select
                  aria-label="Chat TTS voice"
                  value={executionConfig.ttsVoice ?? 'alloy'}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      ttsVoice: e.target.value,
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="alloy">alloy</option>
                  <option value="echo">echo</option>
                  <option value="fable">fable</option>
                  <option value="onyx">onyx</option>
                  <option value="nova">nova</option>
                  <option value="shimmer">shimmer</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <label className="inline-flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  aria-label="Chat SSE stream"
                  checked={executionConfig.stream && isParamActive('stream')}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      stream: e.target.checked,
                      activeParams: { ...activeParams, stream: e.target.checked },
                    })
                  }
                />
                <span>SSE Stream</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  aria-label="Chat randomize model order"
                  checked={Boolean(executionConfig.randomizeOrder)}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      randomizeOrder: e.target.checked,
                    })
                  }
                />
                <span>Random Order</span>
              </label>
            </div>
          </div>

          {/* Custom Extra Params (+ Add Param) */}
          <div
            className="rounded-lg border p-3 space-y-2.5"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-primary)' }}>
                Custom Send Params ({extraParams.filter((p) => p.enabled).length}/{extraParams.length})
              </span>
              <button
                type="button"
                aria-label="+ Add Param"
                onClick={handleAddParam}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-medium cursor-pointer"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--accent-primary)',
                }}
              >
                <Plus className="w-3 h-3" />
                <span>+ Add Param</span>
              </button>
            </div>

            <div className="grid grid-cols-12 gap-1.5 items-center">
              <input
                type="text"
                aria-label="New param key"
                value={newParamKey}
                onChange={(e) => setNewParamKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddParam();
                  }
                }}
                placeholder="key (e.g. presence_penalty)"
                className="col-span-5 px-2 py-1 rounded border text-[11px] font-mono"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
              <input
                type="text"
                aria-label="New param value"
                value={newParamValue}
                onChange={(e) => setNewParamValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddParam();
                  }
                }}
                placeholder='value (e.g. 0.2 or ["END"])'
                className="col-span-5 px-2 py-1 rounded border text-[11px] font-mono"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
              <button
                type="button"
                aria-label="Submit add param"
                onClick={handleAddParam}
                className="col-span-2 px-2 py-1 rounded text-[11px] font-semibold cursor-pointer text-center"
                style={{
                  backgroundColor: 'var(--accent-primary)',
                  color: 'var(--accent-contrast)',
                }}
              >
                Add
              </button>
            </div>

            {extraParams.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {extraParams.map((param) => (
                  <div
                    key={param.id}
                    className={`grid grid-cols-12 gap-1.5 items-center p-1.5 rounded border ${
                      param.enabled ? '' : 'opacity-60'
                    }`}
                    style={{
                      borderColor: 'var(--border-subtle)',
                      backgroundColor: 'var(--bg-surface)',
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Activate param ${param.key}`}
                      checked={param.enabled}
                      onChange={(e) =>
                        updateExtraParam(param.id, { enabled: e.target.checked })
                      }
                      className="col-span-1 justify-self-center cursor-pointer"
                    />
                    <input
                      type="text"
                      aria-label={`Custom param key ${param.key}`}
                      value={param.key}
                      onChange={(e) => updateExtraParam(param.id, { key: e.target.value })}
                      className="col-span-5 px-1.5 py-0.5 rounded border text-[11px] font-mono"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <input
                      type="text"
                      aria-label={`Custom param value ${param.key}`}
                      value={param.value}
                      onChange={(e) => updateExtraParam(param.id, { value: e.target.value })}
                      className="col-span-5 px-1.5 py-0.5 rounded border text-[11px] font-mono"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Remove param ${param.key}`}
                      onClick={() => removeExtraParam(param.id)}
                      className="col-span-1 p-0.5 justify-self-center cursor-pointer hover:opacity-80"
                      style={{ color: 'var(--status-error)' }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* System Prompt & Target Override */}
          <div
            className="rounded-lg border p-3 space-y-2.5"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-primary)' }}>
                System Prompt Layer
              </span>
              <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                <input
                  type="checkbox"
                  aria-label="Chat system prompt enabled"
                  checked={systemPrompt.enabled}
                  onChange={(e) =>
                    onSystemPromptChange({ ...systemPrompt, enabled: e.target.checked })
                  }
                />
                <span>Active</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>System Persona</span>
                <select
                  aria-label="Chat system persona"
                  value={systemPrompt.personaId ?? ''}
                  onChange={(e) => {
                    const pid = e.target.value || null;
                    const found = SYSTEM_PERSONAS.find((p) => p.id === pid);
                    onSystemPromptChange({
                      ...systemPrompt,
                      enabled: pid ? true : systemPrompt.enabled,
                      personaId: pid,
                      content: found ? found.prompt : systemPrompt.content,
                    });
                  }}
                  className="w-full px-2 py-1.5 rounded border text-xs"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="">Custom / None</option>
                  {SYSTEM_PERSONAS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Targeting Mode</span>
                <select
                  aria-label="Chat system target mode"
                  value={systemPrompt.targetMode}
                  onChange={(e) =>
                    onSystemPromptChange({
                      ...systemPrompt,
                      targetMode: e.target.value as 'all' | 'specific',
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="all">All Models</option>
                  <option value="specific">Specific Models</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>Global System Prompt Content</span>
              <textarea
                aria-label="Chat system prompt content"
                rows={3}
                value={systemPrompt.content}
                placeholder="Enter global system instructions..."
                onChange={(e) =>
                  onSystemPromptChange({
                    ...systemPrompt,
                    personaId: null,
                    content: e.target.value,
                  })
                }
                className="w-full px-2 py-1.5 rounded border text-xs leading-relaxed resize-y"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>

            <label className="block space-y-1">
              <span style={{ color: 'var(--text-muted)' }}>
                Per-Target System Override ({activeTarget?.modelName ?? 'none'})
              </span>
              <textarea
                aria-label="Chat target system override"
                rows={2}
                value={activeTarget?.systemPromptOverride ?? ''}
                placeholder="Overrides global system prompt for this target only..."
                onChange={(e) => {
                  const val = e.target.value;
                  updateActiveTarget({
                    systemPromptOverride: val.trim().length > 0 ? val : undefined,
                  });
                }}
                className="w-full px-2 py-1.5 rounded border text-xs leading-relaxed resize-y"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>
          </div>

          {/* Execution Mode & Attached Files */}
          <div
            className="rounded-lg border p-3 space-y-2.5"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-primary)' }}>
              Pool & Attachments
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Execution Mode</span>
                <select
                  aria-label="Chat execution mode"
                  value={executionConfig.mode}
                  onChange={(e) =>
                    onExecutionConfigChange({
                      ...executionConfig,
                      mode: e.target.value as 'parallel' | 'sequential',
                    })
                  }
                  className="w-full px-2 py-1.5 rounded border text-xs"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="parallel">Parallel Pool</option>
                  <option value="sequential">Sequential</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span style={{ color: 'var(--text-muted)' }}>Concurrent Workers</span>
                <input
                  type="number"
                  aria-label="Chat concurrent workers"
                  min={1}
                  max={100}
                  value={executionConfig.concurrency}
                  onChange={(e) => {
                    const parsed = Number(e.target.value);
                    onExecutionConfigChange({
                      ...executionConfig,
                      concurrency: Number.isFinite(parsed)
                        ? Math.min(Math.max(Math.round(parsed), 1), 100)
                        : 1,
                    });
                  }}
                  className="w-full px-2 py-1.5 rounded border text-xs font-mono tabular-nums"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>
            </div>

            <div className="space-y-1.5 pt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    aria-label="Activate Endpoint Files param"
                    checked={isParamActive('endpointFiles')}
                    onChange={(e) => setParamActive('endpointFiles', e.target.checked)}
                  />
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>Endpoint Files ({activeFiles.length}/{endpointFiles.length} active)</span>
                </label>
              </div>
              {endpointFiles.length === 0 ? (
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  No files attached. Upload files in Configuration & Models if needed.
                </p>
              ) : (
                <div className="space-y-1 max-h-28 overflow-y-auto">
                  {endpointFiles.map((f) => (
                    <label
                      key={f.id}
                      className="flex items-center justify-between gap-2 px-2 py-1 rounded border cursor-pointer"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        backgroundColor: 'var(--bg-surface)',
                      }}
                    >
                      <span className="inline-flex items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          checked={f.enabled}
                          onChange={(e) =>
                            onEndpointFilesChange(
                              endpointFiles.map((item) =>
                                item.id === f.id ? { ...item, enabled: e.target.checked } : item
                              )
                            )
                          }
                        />
                        <span className="truncate font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>
                          {f.name}
                        </span>
                      </span>
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {f.endpointScope}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Right Pane: Scrollable Chat Transcript & Composer */}
      <section
        className="lg:col-span-7 rounded-xl border flex flex-col overflow-hidden min-h-0"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        {/* Chat Header */}
        <div
          className="px-4 py-2.5 border-b flex flex-wrap items-center justify-between gap-2 shrink-0"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2 min-w-0 text-xs">
            <MessageSquare className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
            <span className="font-semibold font-display truncate" style={{ color: 'var(--text-primary)' }}>
              {activeTarget?.modelName ?? 'No Target'}
            </span>
            {activeProvider && (
              <span className="truncate" style={{ color: 'var(--text-muted)' }}>
                ({activeProvider.name})
              </span>
            )}
            {statusBadge && (
              <span
                className="px-1.5 py-0.5 rounded border text-[10px] font-mono tabular-nums font-semibold"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color:
                    statusBadge.category === 'ok'
                      ? 'var(--status-success)'
                      : statusBadge.category === 'rate-limit'
                      ? 'var(--status-warning)'
                      : 'var(--status-error)',
                }}
              >
                {statusBadge.badgeText}
              </span>
            )}
            {lastResult && (
              <span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                TTFB {formatMs(lastResult.timing.ttfbMs)} · {lastResult.tokensPerSec > 0 ? `${lastResult.tokensPerSec} tok/s` : '— tok/s'} · {formatMs(lastResult.timing.totalMs)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onResetChat}
              disabled={isRunning}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border text-xs cursor-pointer disabled:opacity-40"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-secondary)',
              }}
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
            {isRunning && (
              <button
                type="button"
                onClick={onAbort}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold cursor-pointer"
                style={{
                  backgroundColor: 'var(--status-error)',
                  color: '#ffffff',
                }}
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </button>
            )}
          </div>
        </div>

        {/* Scrollable Transcript */}
        <div
          ref={transcriptScrollRef}
          data-testid="chat-transcript"
          className="flex-1 overflow-y-auto p-4 space-y-3"
        >
          {resolvedSystemPrompt && (
            <div
              className="p-3 rounded-lg border text-xs space-y-1"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <div className="font-mono text-[11px] font-semibold" style={{ color: 'var(--status-warning)' }}>
                [SYSTEM]
              </div>
              <p className="whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {resolvedSystemPrompt}
              </p>
            </div>
          )}

          {messages.length === 0 ? (
            <div
              className="rounded-lg border p-6 text-center text-xs"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-canvas)',
                color: 'var(--text-muted)',
              }}
            >
              No messages yet. Press Enter from Prompt, Responses, or Waterfall to load a response, or type a message below.
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              const isLastErr =
                idx === messages.length - 1 &&
                !isUser &&
                lastResult?.status === 'error' &&
                Boolean(lastResult.error);

              return (
                <div
                  key={msg.id}
                  className="p-3.5 rounded-lg border space-y-1.5"
                  style={{
                    borderColor: isLastErr
                      ? 'var(--status-error)'
                      : isUser
                      ? 'var(--accent-primary)'
                      : 'var(--border-subtle)',
                    backgroundColor: isUser ? 'var(--bg-elevated)' : 'var(--bg-canvas)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                    <span
                      className="font-semibold"
                      style={{
                        color: isUser
                          ? 'var(--accent-primary)'
                          : isLastErr
                          ? 'var(--status-error)'
                          : 'var(--status-success)',
                      }}
                    >
                      {isUser ? '[USER]' : `[ASSISTANT · ${activeTarget?.modelName ?? 'model'}]`}
                    </span>
                    {isRunning && idx === messages.length - 1 && !isUser && (
                      <span style={{ color: 'var(--status-warning)' }}>Streaming...</span>
                    )}
                  </div>

                  {isLastErr && (
                    <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--status-error)' }}>
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {lastResult?.httpStatus ? `HTTP ${lastResult.httpStatus} · ` : ''}
                        {lastResult?.error}
                      </span>
                    </div>
                  )}

                  {isUser ? (
                    <p className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                      {msg.content}
                    </p>
                  ) : (
                    <MarkdownRenderer content={msg.content || '...'} />
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Composer */}
        <div
          className="p-3 border-t space-y-2 shrink-0"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-elevated)',
          }}
        >
          <textarea
            aria-label="Chat follow-up message"
            rows={2}
            value={chatInput}
            onChange={(e) => onChatInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!isRunning) onSendTurn();
              }
            }}
            placeholder="Type a follow-up message (Enter to send, Shift+Enter newline) — or press Send to resend with edited Send Config..."
            className="w-full rounded-lg border p-2.5 text-xs leading-relaxed resize-y focus:outline-none focus-visible:ring-2"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-primary)',
            }}
          />
          <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>Check params to include when sending · Use + Add Param for custom fields · Shift+↑/↓ scrolls</span>
            <button
              type="button"
              onClick={onSendTurn}
              disabled={isRunning || !activeTarget}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer disabled:opacity-40 whitespace-nowrap"
              style={{
                backgroundColor: 'var(--accent-primary)',
                color: 'var(--accent-contrast)',
              }}
            >
              <Send className="w-3.5 h-3.5" />
              <span>{chatInput.trim() ? 'Send Turn' : 'Send / Resend'}</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

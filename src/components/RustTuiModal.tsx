import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, Terminal, X } from 'lucide-react';
import type {
  ExecutionConfig,
  ModelRunResult,
  ProviderEndpoint,
  SupabaseConfig,
  SystemPromptConfig,
  TargetModel,
  ThemeId,
} from '../types/benchmark';
import { triggerFileDownload } from '../utils/exportUtils';
import { formatMs } from '../utils/metrics';
import { generateBenchforgeToml } from '../utils/tomlConfig';

interface RustTuiModalProps {
  open: boolean;
  onClose: () => void;
  executionConfig: ExecutionConfig;
  systemPrompt: SystemPromptConfig;
  theme: ThemeId;
  supabaseConfig: SupabaseConfig;
  providers: ProviderEndpoint[];
  targets: TargetModel[];
  results: ModelRunResult[];
  prompt: string;
}

type TuiSimTab = '1:Prompt' | '2:Responses' | '3:Waterfall' | '6:Config';

export const RustTuiModal: React.FC<RustTuiModalProps> = ({
  open,
  onClose,
  executionConfig,
  systemPrompt,
  theme,
  supabaseConfig,
  providers,
  targets,
  results,
  prompt,
}) => {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [copiedToml, setCopiedToml] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [simTab, setSimTab] = useState<TuiSimTab>('6:Config');

  const tomlOutput = useMemo(
    () =>
      generateBenchforgeToml({
        executionConfig,
        systemPrompt,
        theme,
        supabaseConfig,
        providers,
        targets,
        includeInlineSecrets: includeSecrets,
      }),
    [executionConfig, systemPrompt, theme, supabaseConfig, providers, targets, includeSecrets]
  );

  if (!open) return null;

  const cliCommand = 'cd rust-tui && cargo run -- config validate && cargo run --release';

  const handleCopyToml = () => {
    navigator.clipboard?.writeText(tomlOutput).catch(() => {});
    setCopiedToml(true);
    setTimeout(() => setCopiedToml(false), 1500);
  };

  const handleCopyCli = () => {
    navigator.clipboard?.writeText(cliCommand).catch(() => {});
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 1500);
  };

  const handleDownloadToml = () => {
    triggerFileDownload('benchforge.toml', tomlOutput, 'application/toml;charset=utf-8');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Rust TUI and Configuration Export"
    >
      <div
        className="w-full max-w-5xl max-h-[90vh] rounded-xl border flex flex-col overflow-hidden"
        style={{
          borderColor: 'var(--border-strong)',
          backgroundColor: 'var(--bg-surface)',
          color: 'var(--text-primary)',
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-3.5 border-b flex items-center justify-between gap-4"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
        >
          <div className="flex items-center gap-2.5">
            <Terminal className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            <h2 className="text-sm font-semibold font-display">
              Rust TUI Edition (benchforge-tui) & TOML Configuration
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Rust TUI modal"
            className="p-1.5 rounded border cursor-pointer"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
            }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Left: Live TOML Config Generator */}
          <div className="space-y-3 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold font-display" style={{ color: 'var(--text-primary)' }}>
                  Synced benchforge.toml
                </h3>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Resolves via --config, ./benchforge.toml, or ~/.config/benchforge/config.toml
                </p>
              </div>
              <label className="inline-flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={includeSecrets}
                  onChange={(e) => setIncludeSecrets(e.target.checked)}
                />
                <span>Inline keys</span>
              </label>
            </div>

            <pre
              className="flex-1 min-h-[280px] max-h-[360px] overflow-auto p-3 rounded-lg border text-[11px] font-mono leading-relaxed"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--code-bg)',
                color: 'var(--text-primary)',
              }}
            >
              {tomlOutput}
            </pre>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadToml}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent-primary)',
                  color: 'var(--accent-contrast)',
                }}
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download benchforge.toml</span>
              </button>
              <button
                type="button"
                onClick={handleCopyToml}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                }}
              >
                {copiedToml ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedToml ? 'Copied TOML' : 'Copy TOML'}</span>
              </button>
            </div>
          </div>

          {/* Right: Interactive ratatui Preview & CLI Setup */}
          <div className="space-y-3 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold font-display" style={{ color: 'var(--text-primary)' }}>
                ratatui Terminal Layout Preview
              </h3>
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                rust-tui/src/
              </span>
            </div>

            {/* Terminal Screen Mockup synced with real app state */}
            <div
              className="rounded-lg border p-3 font-mono text-[11px] space-y-2.5 flex-1 flex flex-col"
              style={{
                borderColor: 'var(--border-strong)',
                backgroundColor: 'var(--bg-canvas)',
                color: 'var(--text-primary)',
              }}
            >
              {/* TUI Tab Bar */}
              <div
                className="pb-2 border-b flex flex-wrap items-center justify-between gap-2"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <div className="flex flex-wrap gap-2">
                  {(['1:Prompt', '2:Responses', '3:Waterfall', '6:Config'] as TuiSimTab[]).map(
                    (tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setSimTab(tab)}
                        className="px-1.5 py-0.5 rounded cursor-pointer"
                        style={{
                          backgroundColor:
                            simTab === tab ? 'var(--accent-soft)' : 'transparent',
                          color:
                            simTab === tab ? 'var(--accent-primary)' : 'var(--text-muted)',
                        }}
                      >
                        {tab}
                      </button>
                    )
                  )}
                </div>
                <span style={{ color: 'var(--text-muted)' }}>Theme: {theme}</span>
              </div>

              {/* TUI Body */}
              <div className="flex-1 overflow-y-auto max-h-[250px] space-y-1.5">
                {simTab === '6:Config' && (
                  <>
                    <div style={{ color: 'var(--accent-primary)' }}>
                      Config File: ./benchforge.toml
                    </div>
                    <div>
                      Mode [m]: {executionConfig.mode} · Threads [+/-]: {executionConfig.concurrency} · Timeout [[/]]: {executionConfig.timeoutSec}s · Stream [v]: {String(executionConfig.stream)}
                    </div>
                    <div>
                      System Prompt [p]: {String(systemPrompt.enabled)} · Persona [P]: {systemPrompt.personaId ?? 'none'}
                    </div>
                    <div className="pt-1" style={{ color: 'var(--text-muted)' }}>
                      Target Providers (Space: Toggle All · d: Refresh · D: All · Shift+Tab: Next):
                    </div>
                    {providers.map((p) => {
                      const pTargets = targets.filter((t) => t.providerId === p.id);
                      const enabledCount = pTargets.filter((t) => t.enabled).length;
                      const mark =
                        pTargets.length > 0 && enabledCount === pTargets.length
                          ? '[x]'
                          : enabledCount > 0
                            ? '[~]'
                            : '[ ]';
                      return (
                        <div key={p.id}>
                          {mark} {p.name} ({enabledCount}/{pTargets.length})
                        </div>
                      );
                    })}
                    <div className="pt-1" style={{ color: 'var(--text-muted)' }}>
                      Model Filter [/ to type]: ________________________
                    </div>
                    <div style={{ color: 'var(--text-muted)' }}>
                      Target Models (Shift+Tab: Focus · Space Toggle · s Save):
                    </div>
                    {targets.map((t) => (
                      <div key={t.id}>
                        {t.enabled ? '[x]' : '[ ]'} {t.modelName} @ {t.providerName}
                      </div>
                    ))}
                  </>
                )}

                {simTab === '1:Prompt' && (
                  <>
                    <div style={{ color: 'var(--accent-primary)' }}>
                      Active Prompt (press &apos;i&apos; to edit):
                    </div>
                    <div className="whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                      {prompt}
                    </div>
                  </>
                )}

                {simTab === '2:Responses' && (
                  results.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)' }}>No responses yet. Press &apos;r&apos; in TUI to run.</div>
                  ) : (
                    results.map((r) => (
                      <div key={r.targetId} className="pb-1.5 border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div style={{ color: 'var(--accent-primary)' }}>
                          {r.modelName} [{r.status}] · TTFB {formatMs(r.timing.ttfbMs)} · {r.tokensPerSec} t/s
                        </div>
                        <div className="truncate" style={{ color: 'var(--text-secondary)' }}>
                          {r.output || r.error || 'Idle'}
                        </div>
                      </div>
                    ))
                  )
                )}

                {simTab === '3:Waterfall' && (
                  results.map((r) => (
                    <div key={r.targetId} className="flex justify-between gap-2 tabular-nums">
                      <span className="truncate">{r.modelName}</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        Q:{r.timing.queueMs.toFixed(0)}ms · TTFB:{formatMs(r.timing.ttfbMs)} · Tot:{formatMs(r.timing.totalMs)}
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* TUI Status Footer */}
              <div
                className="pt-2 border-t text-[10px]"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
              >
                [READY] 1-6 Tabs · r Run · R Retry · s Save TOML · t Theme · e Export · q Quit
              </div>
            </div>

            {/* CLI Quick Start */}
            <div
              className="rounded-lg border p-2.5 flex items-center justify-between gap-2 text-xs font-mono"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <code className="truncate" style={{ color: 'var(--text-primary)' }}>
                {cliCommand}
              </code>
              <button
                type="button"
                onClick={handleCopyCli}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer shrink-0"
                style={{
                  borderColor: 'var(--border-subtle)',
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--text-secondary)',
                }}
              >
                {copiedCmd ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

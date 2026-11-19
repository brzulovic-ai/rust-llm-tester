import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  RotateCcw,
  Volume2,
} from 'lucide-react';
import type { ModelRunResult } from '../types/benchmark';
import { classifyResultStatus, extractHtmlSnippet, formatMs } from '../utils/metrics';
import { MarkdownRenderer } from './MarkdownRenderer';
import { TtsPlayer } from './TtsPlayer';

type CardOutputTab = 'formatted' | 'raw' | 'html' | 'audio';

interface ResultCardProps {
  result: ModelRunResult;
  onRetry: (targetId: string) => void;
  isSelected?: boolean;
  onSelect?: (targetId: string) => void;
  onOpenChat?: (result: ModelRunResult) => void;
}

export const ResultCard: React.FC<ResultCardProps> = ({
  result,
  onRetry,
  isSelected = false,
  onSelect,
  onOpenChat,
}) => {
  const [activeTab, setActiveTab] = useState<CardOutputTab>('formatted');
  const [copied, setCopied] = useState(false);

  const htmlSnippet = useMemo(() => extractHtmlSnippet(result.output), [result.output]);
  const statusInfo = useMemo(() => classifyResultStatus(result), [result]);

  const handleCopy = () => {
    if (!result.output) return;
    navigator.clipboard?.writeText(result.output).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const statusColor =
    statusInfo.category === 'ok'
      ? 'var(--status-success)'
      : statusInfo.category === 'rate-limit' || statusInfo.category === 'quota' || statusInfo.category === 'timeout' || statusInfo.category === 'aborted'
      ? 'var(--status-warning)'
      : result.status === 'error'
      ? 'var(--status-error)'
      : 'var(--accent-primary)';

  const statusLabel =
    result.status === 'queued'
      ? 'Queued'
      : result.status === 'connecting'
      ? 'Connecting'
      : result.status === 'streaming'
      ? 'Streaming'
      : result.status === 'completed'
      ? 'Completed'
      : result.status === 'error'
      ? 'Failed'
      : result.status === 'aborted'
      ? 'Aborted'
      : 'Idle';

  const isRunning = result.status === 'queued' || result.status === 'connecting' || result.status === 'streaming';

  return (
    <article
      tabIndex={0}
      aria-selected={isSelected}
      onClick={() => onSelect?.(result.targetId)}
      onFocus={() => onSelect?.(result.targetId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onOpenChat) {
          const tag = (e.target as HTMLElement | null)?.tagName;
          if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA') return;
          e.preventDefault();
          onOpenChat(result);
        }
      }}
      className="rounded-xl border flex flex-col overflow-hidden focus:outline-none focus-visible:ring-2"
      style={{
        borderColor: isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)',
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      {/* Card Header */}
      <div
        className="px-4 py-3 border-b flex items-center justify-between gap-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1 flex items-center gap-2 overflow-x-auto whitespace-nowrap">
          <h3
            className="text-sm font-semibold font-display truncate shrink-0 max-w-[200px]"
            title={result.modelName}
            style={{ color: 'var(--text-primary)' }}
          >
            {result.modelName}
          </h3>
          <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden="true">
            ·
          </span>
          <span className="text-xs truncate shrink-0 max-w-[120px]" style={{ color: 'var(--text-muted)' }}>
            {result.providerName}
          </span>
          <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden="true">
            ·
          </span>
          <span
            className="inline-flex items-center gap-1 text-xs font-medium shrink-0"
            style={{ color: statusColor }}
          >
            {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
            <span>{statusLabel}</span>
          </span>
          {!isRunning && result.status !== 'idle' && (
            <span
              className="px-1.5 py-0.5 rounded border text-[10px] font-mono tabular-nums font-semibold shrink-0"
              style={{
                color: statusColor,
                borderColor: statusColor,
                backgroundColor:
                  statusInfo.category === 'rate-limit'
                    ? 'rgba(245, 158, 11, 0.16)'
                    : statusInfo.category === 'ok'
                    ? 'rgba(22, 163, 74, 0.10)'
                    : 'rgba(239, 68, 68, 0.10)',
              }}
            >
              {statusInfo.badgeText}
            </span>
          )}
          <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden="true">
            ·
          </span>
          <span
            data-testid="card-inline-metrics"
            className="inline-flex items-center gap-1.5 text-xs font-mono tabular-nums whitespace-nowrap shrink-0"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>TTFB {formatMs(result.timing.ttfbMs)}</span>
            <span aria-hidden="true">·</span>
            <span>{result.tokensPerSec > 0 ? `${result.tokensPerSec} tok/s` : '— tok/s'}</span>
            <span aria-hidden="true">·</span>
            <span>{result.completionTokens} out tok</span>
            <span aria-hidden="true">·</span>
            <span>Total {formatMs(result.timing.totalMs)}</span>
            {result.endpointUrl && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate max-w-[180px]" title={result.endpointUrl}>
                  {result.endpointUrl}
                </span>
              </>
            )}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {onOpenChat && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelect?.(result.targetId);
                onOpenChat(result);
              }}
              title="Open response & editable Send Config in Chat (Enter)"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer whitespace-nowrap shrink-0"
              style={{
                borderColor: 'var(--border-subtle)',
                color: 'var(--accent-primary)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Chat</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            disabled={!result.output}
            title="Copy output"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            type="button"
            onClick={() => onRetry(result.targetId)}
            disabled={isRunning}
            title="Retry model"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--bg-elevated)',
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      </div>

      {/* Output View Mode Tabs */}
      <div
        className="px-4 py-1.5 border-b flex items-center gap-1 overflow-x-auto"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-elevated)',
        }}
      >
        <button
          type="button"
          onClick={() => setActiveTab('formatted')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
          style={{
            backgroundColor: activeTab === 'formatted' ? 'var(--bg-surface)' : 'transparent',
            color: activeTab === 'formatted' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Formatted</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('raw')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
          style={{
            backgroundColor: activeTab === 'raw' ? 'var(--bg-surface)' : 'transparent',
            color: activeTab === 'raw' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <Code2 className="w-3.5 h-3.5" />
          <span>Raw</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('html')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
          style={{
            backgroundColor: activeTab === 'html' ? 'var(--bg-surface)' : 'transparent',
            color: activeTab === 'html' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <Globe className="w-3.5 h-3.5" />
          <span>{htmlSnippet ? 'HTML Live Frame' : 'HTML Preview'}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('audio')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
          style={{
            backgroundColor: activeTab === 'audio' ? 'var(--bg-surface)' : 'transparent',
            color: activeTab === 'audio' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
        >
          <Volume2 className="w-3.5 h-3.5" />
          <span>Audio (TTS)</span>
        </button>
      </div>

      {/* Card Body */}
      <div className="p-4 flex-1 overflow-y-auto max-h-[540px]">
        {result.status === 'error' && (
          <div
            className="mb-3 p-3 rounded-lg border text-xs space-y-1.5"
            style={{
              borderColor: 'var(--status-error)',
              backgroundColor: 'var(--diff-del-bg)',
              color: 'var(--text-primary)',
            }}
          >
            <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--status-error)' }}>
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                {result.httpStatus ? `HTTP ${result.httpStatus} · ` : ''}
                {result.error || 'Execution error'}
              </span>
            </div>
            {result.advice && (
              <p style={{ color: 'var(--text-secondary)' }}>{result.advice}</p>
            )}
          </div>
        )}

        {result.audioDataUrl && activeTab !== 'audio' && (
          <div
            className="mb-3 p-2.5 rounded-lg border space-y-2"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                Generated Audio Output
              </span>
              <a
                href={result.audioDataUrl}
                download={`${result.modelName.replace(/[^a-z0-9-_]/gi, '_')}-speech.mp3`}
                className="inline-flex items-center gap-1 text-[11px] hover:underline"
                style={{ color: 'var(--accent-primary)' }}
              >
                <Download className="w-3 h-3" />
                <span>Download Audio</span>
              </a>
            </div>
            <audio controls src={result.audioDataUrl} className="w-full h-8" />
          </div>
        )}

        {result.status === 'queued' && !result.output && (
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            Waiting for worker slot...
          </p>
        )}

        {result.status === 'connecting' && !result.output && (
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            Opening connection and awaiting first byte...
          </p>
        )}

        {activeTab === 'formatted' && result.output && (
          <MarkdownRenderer content={result.output} />
        )}

        {activeTab === 'raw' && result.output && (
          <pre
            className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {result.output}
          </pre>
        )}

        {activeTab === 'html' && (
          htmlSnippet ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                <span>Sandboxed HTML Frame (scripts allowed, same-origin isolated)</span>
              </div>
              <iframe
                title={`HTML preview for ${result.modelName}`}
                srcDoc={htmlSnippet}
                sandbox="allow-scripts allow-forms"
                className="w-full h-[380px] rounded-lg border bg-white"
                style={{ borderColor: 'var(--border-subtle)' }}
              />
            </div>
          ) : (
            <div
              className="p-4 rounded-lg border text-xs"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-muted)',
              }}
            >
              No HTML document or ```html fenced block detected in this response yet. Run a prompt from "HTML Games Generators" or ask the model for a standalone HTML snippet.
            </div>
          )
        )}

        {activeTab === 'audio' && (
          <div className="space-y-3">
            {result.audioDataUrl && (
              <div
                className="p-3 rounded-lg border space-y-2"
                style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    Endpoint Audio Stream
                  </span>
                  <a
                    href={result.audioDataUrl}
                    download={`${result.modelName.replace(/[^a-z0-9-_]/gi, '_')}-speech.mp3`}
                    className="inline-flex items-center gap-1 text-[11px] hover:underline"
                    style={{ color: 'var(--accent-primary)' }}
                  >
                    <Download className="w-3 h-3" />
                    <span>Download Audio</span>
                  </a>
                </div>
                <audio controls src={result.audioDataUrl} className="w-full" />
              </div>
            )}
            <TtsPlayer text={result.output} modelName={result.modelName} />
          </div>
        )}

        {!result.output && !result.audioDataUrl && result.status === 'idle' && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Ready. Click Run Benchmark to start inference.
          </p>
        )}
      </div>
    </article>
  );
};

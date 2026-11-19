import React, { useMemo, useState } from 'react';
import { ArrowUpDown, MessageSquare } from 'lucide-react';
import type { ModelRunResult } from '../types/benchmark';
import { classifyResultStatus, formatMs, type StatusCategory } from '../utils/metrics';

interface WaterfallViewProps {
  results: ModelRunResult[];
  selectedTargetId?: string | null;
  onSelectResult?: (targetId: string) => void;
  onOpenChat?: (result: ModelRunResult) => void;
}

type SortField = 'totalMs' | 'ttfbMs' | 'tokensPerSec' | 'modelName' | 'errorCode';
type WaterfallFilter = 'all' | 'working' | 'rate-limit' | 'errors';

function getCategoryStyle(category: StatusCategory): React.CSSProperties {
  switch (category) {
    case 'ok':
      return {
        color: 'var(--status-success)',
        backgroundColor: 'rgba(22, 163, 74, 0.12)',
        borderColor: 'rgba(22, 163, 74, 0.35)',
      };
    case 'rate-limit':
      return {
        color: 'var(--status-warning)',
        backgroundColor: 'rgba(245, 158, 11, 0.18)',
        borderColor: 'rgba(245, 158, 11, 0.5)',
      };
    case 'quota':
    case 'timeout':
    case 'aborted':
      return {
        color: 'var(--status-warning)',
        backgroundColor: 'rgba(245, 158, 11, 0.12)',
        borderColor: 'rgba(245, 158, 11, 0.35)',
      };
    case 'auth':
    case 'not-found':
    case 'bad-request':
    case 'server':
    case 'error':
      return {
        color: 'var(--status-error)',
        backgroundColor: 'rgba(239, 68, 68, 0.14)',
        borderColor: 'rgba(239, 68, 68, 0.4)',
      };
    default:
      return {
        color: 'var(--text-muted)',
        backgroundColor: 'transparent',
        borderColor: 'var(--border-subtle)',
      };
  }
}

export const WaterfallView: React.FC<WaterfallViewProps> = ({
  results,
  selectedTargetId,
  onSelectResult,
  onOpenChat,
}) => {
  const [sortField, setSortField] = useState<SortField>('totalMs');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<WaterfallFilter>('all');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const activeSelectedId = selectedTargetId ?? localSelectedId;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const counts = useMemo(() => {
    let working = 0;
    let rateLimited = 0;
    let errors = 0;
    for (const r of results) {
      const cls = classifyResultStatus(r);
      if (cls.category === 'ok') working++;
      else if (cls.category === 'rate-limit') {
        rateLimited++;
        errors++;
      } else if (r.status === 'error') {
        errors++;
      }
    }
    return { total: results.length, working, rateLimited, errors };
  }, [results]);

  const { sorted, maxTotalMs, minEnqueuedAt } = useMemo(() => {
    const filtered = results.filter((r) => {
      if (statusFilter === 'all') return true;
      const cls = classifyResultStatus(r);
      if (statusFilter === 'working') return cls.category === 'ok';
      if (statusFilter === 'rate-limit') return cls.category === 'rate-limit';
      return r.status === 'error';
    });

    const minEnq = results.reduce(
      (min, r) => (r.timing.enqueuedAt > 0 && r.timing.enqueuedAt < min ? r.timing.enqueuedAt : min),
      results[0]?.timing.enqueuedAt ?? 0
    );

    const maxSpan = Math.max(
      1,
      ...results.map((r) => {
        const offset = Math.max(0, r.timing.enqueuedAt - minEnq);
        return offset + r.timing.totalMs;
      })
    );

    const list = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'modelName') {
        cmp = a.modelName.localeCompare(b.modelName);
      } else if (sortField === 'errorCode') {
        const ca = classifyResultStatus(a);
        const cb = classifyResultStatus(b);
        const na = ca.httpCode ?? (ca.category === 'ok' ? 200 : 999);
        const nb = cb.httpCode ?? (cb.category === 'ok' ? 200 : 999);
        cmp = na - nb || ca.badgeText.localeCompare(cb.badgeText);
      } else if (sortField === 'ttfbMs') {
        cmp = (a.timing.ttfbMs ?? Number.MAX_SAFE_INTEGER) - (b.timing.ttfbMs ?? Number.MAX_SAFE_INTEGER);
      } else if (sortField === 'tokensPerSec') {
        cmp = a.tokensPerSec - b.tokensPerSec;
      } else {
        cmp = a.timing.totalMs - b.timing.totalMs;
      }
      return sortAsc ? cmp : -cmp;
    });

    return { sorted: list, maxTotalMs: maxSpan, minEnqueuedAt: minEnq };
  }, [results, sortField, sortAsc, statusFilter]);

  if (results.length === 0) {
    return (
      <div
        className="rounded-xl border p-8 text-center text-sm"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
          color: 'var(--text-muted)',
        }}
      >
        Run a benchmark to inspect the sub-millisecond DevTools Network Waterfall across models.
      </div>
    );
  }

  const hoveredResult = sorted.find((r) => r.targetId === hoveredId) ?? null;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{
        borderColor: 'var(--border-subtle)',
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      {/* Legend & Quick Status Filters */}
      <div
        className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3 text-xs"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
      >
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-semibold font-display" style={{ color: 'var(--text-primary)' }}>
            Network Timing Waterfall
          </span>
          <div className="flex items-center gap-3" style={{ color: 'var(--text-secondary)' }}>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-xs inline-block bg-slate-400" />
              Queue
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-xs inline-block bg-amber-500" />
              Request / TTFB Wait
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-xs inline-block bg-emerald-500" />
              Token Download
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex items-center gap-1 p-0.5 rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}
            role="group"
            aria-label="Filter models by status"
          >
            {(
              [
                { id: 'all', label: `All (${counts.total})` },
                { id: 'working', label: `Working (${counts.working})` },
                { id: 'rate-limit', label: `429 Rate Limit (${counts.rateLimited})` },
                { id: 'errors', label: `Errors (${counts.errors})` },
              ] as const
            ).map((f) => {
              const active = statusFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatusFilter(f.id)}
                  className="px-2 py-1 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap"
                  style={{
                    backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
                    color: active
                      ? f.id === 'rate-limit'
                        ? 'var(--status-warning)'
                        : f.id === 'errors'
                        ? 'var(--status-error)'
                        : f.id === 'working'
                        ? 'var(--status-success)'
                        : 'var(--accent-primary)'
                      : 'var(--text-muted)',
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
            Window: {formatMs(maxTotalMs)}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr
              className="border-b text-left"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
            >
              <th className="px-4 py-2.5 font-medium">
                <button
                  type="button"
                  onClick={() => handleSort('modelName')}
                  className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
                >
                  <span>Model</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium">
                <button
                  type="button"
                  onClick={() => handleSort('errorCode')}
                  className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
                >
                  <span>Code / Error</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium text-right font-mono">Queue</th>
              <th className="px-3 py-2.5 font-medium text-right font-mono">Request</th>
              <th className="px-3 py-2.5 font-medium text-right font-mono">
                <button
                  type="button"
                  onClick={() => handleSort('ttfbMs')}
                  className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
                >
                  <span>TTFB</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium text-right font-mono">Download</th>
              <th className="px-3 py-2.5 font-medium text-right font-mono">
                <button
                  type="button"
                  onClick={() => handleSort('totalMs')}
                  className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
                >
                  <span>Total</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th className="px-3 py-2.5 font-medium text-right font-mono">
                <button
                  type="button"
                  onClick={() => handleSort('tokensPerSec')}
                  className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80"
                >
                  <span>Speed</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th className="px-4 py-2.5 font-medium min-w-[220px]">Timeline</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const offsetMs = Math.max(0, r.timing.enqueuedAt - minEnqueuedAt);
              const leftPct = (offsetMs / maxTotalMs) * 100;
              const queuePct = (r.timing.queueMs / maxTotalMs) * 100;
              const waitMs = r.timing.ttfbMs !== null ? r.timing.ttfbMs : r.timing.requestMs;
              const waitPct = (waitMs / maxTotalMs) * 100;
              const downloadPct = (r.timing.downloadMs / maxTotalMs) * 100;
              const statusInfo = classifyResultStatus(r);
              const isRowSelected = activeSelectedId === r.targetId;
              const rowHighlightBg =
                isRowSelected || hoveredId === r.targetId
                  ? 'var(--bg-elevated)'
                  : statusInfo.category === 'rate-limit'
                  ? 'rgba(245, 158, 11, 0.06)'
                  : r.status === 'error'
                  ? 'rgba(239, 68, 68, 0.05)'
                  : 'transparent';

              return (
                <tr
                  key={r.targetId}
                  tabIndex={0}
                  aria-selected={isRowSelected}
                  onMouseEnter={() => setHoveredId(r.targetId)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    setLocalSelectedId(r.targetId);
                    onSelectResult?.(r.targetId);
                  }}
                  onDoubleClick={() => onOpenChat?.(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && onOpenChat) {
                      e.preventDefault();
                      setLocalSelectedId(r.targetId);
                      onSelectResult?.(r.targetId);
                      onOpenChat(r);
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const curIdx = sorted.findIndex((item) => item.targetId === r.targetId);
                      const nextIdx =
                        e.key === 'ArrowDown'
                          ? Math.min(curIdx + 1, sorted.length - 1)
                          : Math.max(curIdx - 1, 0);
                      const nextItem = sorted[nextIdx];
                      if (nextItem) {
                        setLocalSelectedId(nextItem.targetId);
                        onSelectResult?.(nextItem.targetId);
                      }
                    }
                  }}
                  className="border-b last:border-b-0 transition-colors cursor-pointer focus:outline-none"
                  style={{
                    borderColor: isRowSelected ? 'var(--accent-primary)' : 'var(--border-subtle)',
                    backgroundColor: rowHighlightBg,
                  }}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {r.modelName}
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {r.providerName} · {r.status}
                        </div>
                      </div>
                      {onOpenChat && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLocalSelectedId(r.targetId);
                            onSelectResult?.(r.targetId);
                            onOpenChat(r);
                          }}
                          title="Open row in Chat (Enter)"
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium cursor-pointer shrink-0"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            backgroundColor: 'var(--bg-surface)',
                            color: 'var(--accent-primary)',
                          }}
                        >
                          <MessageSquare className="w-3 h-3" />
                          <span>Chat</span>
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5" title={r.error || r.advice || statusInfo.badgeText}>
                    <div className="flex flex-col gap-0.5 items-start">
                      <span
                        className="inline-block px-1.5 py-0.5 rounded border text-[11px] font-mono tabular-nums font-semibold whitespace-nowrap"
                        style={getCategoryStyle(statusInfo.category)}
                      >
                        {statusInfo.badgeText}
                      </span>
                      {r.error && (
                        <span
                          className="text-[11px] truncate max-w-[200px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {r.error}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {r.timing.queueMs.toFixed(1)} ms
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {r.timing.requestMs.toFixed(1)} ms
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    {r.timing.ttfbMs !== null ? `${r.timing.ttfbMs.toFixed(1)} ms` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {r.timing.downloadMs.toFixed(1)} ms
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {formatMs(r.timing.totalMs)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                    {r.tokensPerSec > 0 ? `${r.tokensPerSec} t/s` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div
                      className="relative h-5 rounded overflow-hidden flex items-center"
                      style={{ backgroundColor: 'var(--bg-canvas)' }}
                    >
                      <div
                        className="absolute top-1 bottom-1 flex items-center"
                        style={{ left: `${Math.min(leftPct, 99)}%`, width: `${Math.max(queuePct + waitPct + downloadPct, 0.8)}%` }}
                      >
                        {queuePct > 0 && (
                          <div
                            className="h-full bg-slate-400"
                            style={{ width: `${(queuePct / Math.max(queuePct + waitPct + downloadPct, 0.01)) * 100}%` }}
                          />
                        )}
                        {waitPct > 0 && (
                          <div
                            className="h-full bg-amber-500"
                            style={{ width: `${(waitPct / Math.max(queuePct + waitPct + downloadPct, 0.01)) * 100}%` }}
                          />
                        )}
                        {downloadPct > 0 && (
                          <div
                            className={`h-full ${r.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'}`}
                            style={{ width: `${(downloadPct / Math.max(queuePct + waitPct + downloadPct, 0.01)) * 100}%` }}
                          />
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  No models match this status filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Hover Sub-Millisecond Detail Strip */}
      {hoveredResult && (
        <div
          className="px-4 py-2.5 border-t flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
          }}
        >
          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
            {hoveredResult.modelName}
          </span>
          <span>Code: {classifyResultStatus(hoveredResult).badgeText}</span>
          <span>·</span>
          <span>Queue: {hoveredResult.timing.queueMs.toFixed(2)}ms</span>
          <span>·</span>
          <span>Headers: {hoveredResult.timing.requestMs.toFixed(2)}ms</span>
          <span>·</span>
          <span>
            TTFB:{' '}
            {hoveredResult.timing.ttfbMs !== null
              ? `${hoveredResult.timing.ttfbMs.toFixed(2)}ms`
              : '—'}
          </span>
          <span>·</span>
          <span>Stream: {hoveredResult.timing.downloadMs.toFixed(2)}ms</span>
          <span>·</span>
          <span>Total: {hoveredResult.timing.totalMs.toFixed(2)}ms</span>
          <span>·</span>
          <span>
            Tokens: {hoveredResult.promptTokens} in / {hoveredResult.completionTokens} out
          </span>
          {hoveredResult.error && (
            <>
              <span>·</span>
              <span className="truncate max-w-md" style={{ color: 'var(--status-error)' }}>
                {hoveredResult.error}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
};

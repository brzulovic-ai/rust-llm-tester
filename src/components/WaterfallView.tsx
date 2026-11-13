import React, { useMemo, useState } from 'react';
import { ArrowUpDown } from 'lucide-react';
import type { ModelRunResult } from '../types/benchmark';
import { formatMs } from '../utils/metrics';

interface WaterfallViewProps {
  results: ModelRunResult[];
}

type SortField = 'totalMs' | 'ttfbMs' | 'tokensPerSec' | 'modelName';

export const WaterfallView: React.FC<WaterfallViewProps> = ({ results }) => {
  const [sortField, setSortField] = useState<SortField>('totalMs');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const { sorted, maxTotalMs, minEnqueuedAt } = useMemo(() => {
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

    const list = [...results].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'modelName') {
        cmp = a.modelName.localeCompare(b.modelName);
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
  }, [results, sortField, sortAsc]);

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
      {/* Legend */}
      <div
        className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-4 text-xs"
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
        <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
          Window: {formatMs(maxTotalMs)}
        </span>
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
              <th className="px-4 py-2.5 font-medium min-w-[260px]">Timeline</th>
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

              return (
                <tr
                  key={r.targetId}
                  onMouseEnter={() => setHoveredId(r.targetId)}
                  onMouseLeave={() => setHoveredId(null)}
                  className="border-b last:border-b-0 transition-colors"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    backgroundColor:
                      hoveredId === r.targetId ? 'var(--bg-elevated)' : 'transparent',
                  }}
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {r.modelName}
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {r.providerName} · {r.status}
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
        </div>
      )}
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import type { ModelRunResult } from '../types/benchmark';
import { computeTokenDiff } from '../utils/diffEngine';
import { formatMs } from '../utils/metrics';

interface DiffCompareViewProps {
  results: ModelRunResult[];
}

export const DiffCompareView: React.FC<DiffCompareViewProps> = ({ results }) => {
  const [leftId, setLeftId] = useState<string>(() => results[0]?.targetId ?? '');
  const [rightId, setRightId] = useState<string>(() => results[1]?.targetId ?? results[0]?.targetId ?? '');
  const [layoutMode, setLayoutMode] = useState<'side-by-side' | 'unified'>('side-by-side');

  const resolvedLeftId = results.some((r) => r.targetId === leftId)
    ? leftId
    : results[0]?.targetId ?? '';
  const resolvedRightId = results.some((r) => r.targetId === rightId)
    ? rightId
    : results[1]?.targetId ?? results[0]?.targetId ?? '';

  const leftResult = results.find((r) => r.targetId === resolvedLeftId);
  const rightResult = results.find((r) => r.targetId === resolvedRightId);

  const diff = useMemo(() => {
    if (!leftResult || !rightResult) return null;
    return computeTokenDiff(leftResult.output || '', rightResult.output || '');
  }, [leftResult, rightResult]);

  if (results.length < 1) {
    return (
      <div
        className="rounded-xl border p-8 text-center text-sm"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
          color: 'var(--text-muted)',
        }}
      >
        Run at least two models to compare token-level differences side-by-side.
      </div>
    );
  }

  const speedDelta =
    leftResult && rightResult
      ? (rightResult.tokensPerSec - leftResult.tokensPerSec).toFixed(1)
      : '0';
  const ttfbDelta =
    leftResult?.timing.ttfbMs !== null &&
    leftResult?.timing.ttfbMs !== undefined &&
    rightResult?.timing.ttfbMs !== null &&
    rightResult?.timing.ttfbMs !== undefined
      ? Math.round(rightResult.timing.ttfbMs - leftResult.timing.ttfbMs)
      : null;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{
        borderColor: 'var(--border-subtle)',
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      {/* Controls */}
      <div
        className="p-4 border-b flex flex-wrap items-center justify-between gap-4"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium">Baseline (A)</span>
            <select
              value={resolvedLeftId}
              onChange={(e) => setLeftId(e.target.value)}
              className="px-2.5 py-1.5 rounded-md border text-xs font-mono"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            >
              {results.map((r) => (
                <option key={r.targetId} value={r.targetId}>
                  {r.modelName} ({r.providerName})
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium">Candidate (B)</span>
            <select
              value={resolvedRightId}
              onChange={(e) => setRightId(e.target.value)}
              className="px-2.5 py-1.5 rounded-md border text-xs font-mono"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            >
              {results.map((r) => (
                <option key={r.targetId} value={r.targetId}>
                  {r.modelName} ({r.providerName})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg border" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface)' }}>
          <button
            type="button"
            onClick={() => setLayoutMode('side-by-side')}
            className="px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
            style={{
              backgroundColor: layoutMode === 'side-by-side' ? 'var(--accent-primary)' : 'transparent',
              color: layoutMode === 'side-by-side' ? 'var(--accent-contrast)' : 'var(--text-secondary)',
            }}
          >
            Side-by-Side
          </button>
          <button
            type="button"
            onClick={() => setLayoutMode('unified')}
            className="px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
            style={{
              backgroundColor: layoutMode === 'unified' ? 'var(--accent-primary)' : 'transparent',
              color: layoutMode === 'unified' ? 'var(--accent-contrast)' : 'var(--text-secondary)',
            }}
          >
            Unified Diff
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      {diff && leftResult && rightResult && (
        <div
          className="px-4 py-2.5 border-b flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <span>Similarity {diff.stats.similarityPct}%</span>
          <span aria-hidden="true">·</span>
          <span style={{ color: 'var(--diff-add-text)' }}>+{diff.stats.insertions} insertions</span>
          <span aria-hidden="true">·</span>
          <span style={{ color: 'var(--diff-del-text)' }}>-{diff.stats.deletions} deletions</span>
          <span aria-hidden="true">·</span>
          <span>
            Δ Speed: {Number(speedDelta) >= 0 ? `+${speedDelta}` : speedDelta} tok/s
          </span>
          {ttfbDelta !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>Δ TTFB: {ttfbDelta >= 0 ? `+${ttfbDelta}` : ttfbDelta} ms</span>
            </>
          )}
        </div>
      )}

      {/* Diff Body */}
      {diff && leftResult && rightResult && (
        layoutMode === 'unified' ? (
          <div className="p-4 max-h-[580px] overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {diff.segments.map((seg, idx) => {
              if (seg.type === 'equal') {
                return (
                  <span key={idx} style={{ color: 'var(--text-secondary)' }}>
                    {seg.value}
                  </span>
                );
              }
              if (seg.type === 'insert') {
                return (
                  <ins
                    key={idx}
                    className="no-underline rounded-xs px-0.5"
                    style={{ backgroundColor: 'var(--diff-add-bg)', color: 'var(--diff-add-text)' }}
                  >
                    {seg.value}
                  </ins>
                );
              }
              return (
                <del
                  key={idx}
                  className="line-through rounded-xs px-0.5"
                  style={{ backgroundColor: 'var(--diff-del-bg)', color: 'var(--diff-del-text)' }}
                >
                  {seg.value}
                </del>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x" style={{ borderColor: 'var(--border-subtle)' }}>
            {/* Left (Deletions highlighted) */}
            <div className="p-4 max-h-[580px] overflow-y-auto">
              <div
                className="mb-3 pb-2 border-b flex items-center justify-between text-xs"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  A: {leftResult.modelName}
                </span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {leftResult.completionTokens} tok · {formatMs(leftResult.timing.totalMs)}
                </span>
              </div>
              <div className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {diff.segments
                  .filter((seg) => seg.type !== 'insert')
                  .map((seg, idx) =>
                    seg.type === 'delete' ? (
                      <span
                        key={idx}
                        className="rounded-xs px-0.5"
                        style={{
                          backgroundColor: 'var(--diff-del-bg)',
                          color: 'var(--diff-del-text)',
                        }}
                      >
                        {seg.value}
                      </span>
                    ) : (
                      <span key={idx} style={{ color: 'var(--text-secondary)' }}>
                        {seg.value}
                      </span>
                    )
                  )}
              </div>
            </div>

            {/* Right (Insertions highlighted) */}
            <div className="p-4 max-h-[580px] overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
              <div
                className="mb-3 pb-2 border-b flex items-center justify-between text-xs"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  B: {rightResult.modelName}
                </span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {rightResult.completionTokens} tok · {formatMs(rightResult.timing.totalMs)}
                </span>
              </div>
              <div className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {diff.segments
                  .filter((seg) => seg.type !== 'delete')
                  .map((seg, idx) =>
                    seg.type === 'insert' ? (
                      <span
                        key={idx}
                        className="rounded-xs px-0.5"
                        style={{
                          backgroundColor: 'var(--diff-add-bg)',
                          color: 'var(--diff-add-text)',
                        }}
                      >
                        {seg.value}
                      </span>
                    ) : (
                      <span key={idx} style={{ color: 'var(--text-secondary)' }}>
                        {seg.value}
                      </span>
                    )
                  )}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
};

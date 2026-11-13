import React, { useMemo, useState } from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { ModelRunResult } from '../types/benchmark';
import { formatMs } from '../utils/metrics';

interface CapabilityGraphViewProps {
  results: ModelRunResult[];
}

type XAxisMetric = 'ttfbMs' | 'totalMs';
type YAxisMetric = 'tokensPerSec' | 'completionTokens';

const SERIES_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

export const CapabilityGraphView: React.FC<CapabilityGraphViewProps> = ({ results }) => {
  const [xMetric, setXMetric] = useState<XAxisMetric>('ttfbMs');
  const [yMetric, setYMetric] = useState<YAxisMetric>('tokensPerSec');
  const [zoom, setZoom] = useState<number>(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const validPoints = useMemo(() => {
    return results
      .filter((r) => r.status === 'completed' || r.completionTokens > 0)
      .map((r, idx) => {
        const xVal =
          xMetric === 'ttfbMs'
            ? r.timing.ttfbMs ?? r.timing.totalMs
            : r.timing.totalMs;
        const yVal =
          yMetric === 'tokensPerSec' ? r.tokensPerSec : r.completionTokens;
        return {
          result: r,
          xVal,
          yVal,
          color: SERIES_COLORS[idx % SERIES_COLORS.length],
        };
      });
  }, [results, xMetric, yMetric]);

  const width = 760;
  const height = 400;
  const padLeft = 64;
  const padRight = 32;
  const padTop = 28;
  const padBottom = 48;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const { maxX, maxY } = useMemo(() => {
    const rawMaxX = Math.max(100, ...validPoints.map((p) => p.xVal)) * 1.15;
    const rawMaxY = Math.max(10, ...validPoints.map((p) => p.yVal)) * 1.2;
    return {
      maxX: rawMaxX / zoom,
      maxY: rawMaxY / zoom,
    };
  }, [validPoints, zoom]);

  const hoveredPoint = validPoints.find((p) => p.result.targetId === hoveredId) ?? null;

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
        Execute a benchmark to plot model Latency vs Throughput / Token Yield on the XY Capability Graph.
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{
        borderColor: 'var(--border-subtle)',
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      {/* Toolbar */}
      <div
        className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-4"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-elevated)' }}
      >
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold font-display" style={{ color: 'var(--text-primary)' }}>
            XY Capability Scatter Plot
          </span>
          <label className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span>X-Axis</span>
            <select
              value={xMetric}
              onChange={(e) => setXMetric(e.target.value as XAxisMetric)}
              className="px-2 py-1 rounded border text-xs"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="ttfbMs">TTFB Latency (ms)</option>
              <option value="totalMs">Total Duration (ms)</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span>Y-Axis</span>
            <select
              value={yMetric}
              onChange={(e) => setYMetric(e.target.value as YAxisMetric)}
              className="px-2 py-1 rounded border text-xs"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="tokensPerSec">Speed (tokens/sec)</option>
              <option value="completionTokens">Output Tokens</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
            title="Zoom in"
            className="p-1.5 rounded border cursor-pointer"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
            }}
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            title="Zoom out"
            className="p-1.5 rounded border cursor-pointer"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
            }}
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title="Reset zoom"
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded border text-xs font-mono cursor-pointer"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-secondary)',
            }}
          >
            <RotateCcw className="w-3 h-3" />
            <span>{Math.round(zoom * 100)}%</span>
          </button>
        </div>
      </div>

      {/* Plot Canvas */}
      <div className="p-4 relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto max-h-[440px] select-none"
          role="img"
          aria-label="Model latency vs capability scatter plot"
        >
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const y = padTop + plotH * (1 - t);
            const x = padLeft + plotW * t;
            const yLabel = Math.round(maxY * t);
            const xLabel = Math.round(maxX * t);
            return (
              <g key={t}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  stroke="var(--border-subtle)"
                  strokeDasharray={t === 0 ? undefined : '3 3'}
                />
                <text
                  x={padLeft - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                  fill="var(--text-muted)"
                >
                  {yLabel}
                </text>

                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={padTop + plotH}
                  stroke="var(--border-subtle)"
                  strokeDasharray={t === 0 ? undefined : '3 3'}
                />
                <text
                  x={x}
                  y={padTop + plotH + 16}
                  textAnchor="middle"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                  fill="var(--text-muted)"
                >
                  {xLabel}
                </text>
              </g>
            );
          })}

          {/* Axis Labels */}
          <text
            x={padLeft + plotW / 2}
            y={height - 6}
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-secondary)"
          >
            {xMetric === 'ttfbMs' ? 'Time to First Byte (ms) — lower is faster' : 'Total Duration (ms)'}
          </text>

          <text
            x={16}
            y={padTop + plotH / 2}
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-secondary)"
            transform={`rotate(-90, 16, ${padTop + plotH / 2})`}
          >
            {yMetric === 'tokensPerSec' ? 'Throughput (tokens / sec)' : 'Output Tokens'}
          </text>

          {/* Points */}
          {validPoints.map((pt) => {
            const cx = padLeft + Math.min(1, Math.max(0, pt.xVal / maxX)) * plotW;
            const cy = padTop + (1 - Math.min(1, Math.max(0, pt.yVal / maxY))) * plotH;
            const isHovered = hoveredId === pt.result.targetId;

            return (
              <g
                key={pt.result.targetId}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredId(pt.result.targetId)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 9 : 6.5}
                  fill={pt.color}
                  stroke="var(--bg-surface)"
                  strokeWidth={2}
                />
                <text
                  x={cx + 10}
                  y={cy + 4}
                  fontSize="11"
                  fontWeight={isHovered ? '600' : '500'}
                  fill="var(--text-primary)"
                >
                  {pt.result.modelName}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Tooltip Readout */}
        {hoveredPoint && (
          <div
            className="mt-3 px-3.5 py-2.5 rounded-lg border flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums"
            style={{
              borderColor: 'var(--border-subtle)',
              backgroundColor: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
            }}
          >
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              {hoveredPoint.result.modelName}
            </span>
            <span>{hoveredPoint.result.providerName}</span>
            <span>·</span>
            <span>TTFB: {formatMs(hoveredPoint.result.timing.ttfbMs)}</span>
            <span>·</span>
            <span>Total: {formatMs(hoveredPoint.result.timing.totalMs)}</span>
            <span>·</span>
            <span>Speed: {hoveredPoint.result.tokensPerSec} tok/s</span>
            <span>·</span>
            <span>Tokens: {hoveredPoint.result.completionTokens}</span>
          </div>
        )}
      </div>
    </div>
  );
};

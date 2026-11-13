import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { CapabilityGraphView } from '../components/CapabilityGraphView';
import { DiffCompareView } from '../components/DiffCompareView';
import { ResultCard } from '../components/ResultCard';
import { WaterfallView } from '../components/WaterfallView';
import type { ModelRunResult } from '../types/benchmark';
import { createInitialTiming } from '../utils/metrics';

const mockResults: ModelRunResult[] = [
  {
    targetId: 't1',
    modelName: 'gemini-4-hydrogen',
    providerName: 'Gemini Server Engine',
    providerKind: 'gemini-builtin',
    status: 'completed',
    output: '# Title\nFast accurate answer.\n```html\n<!doctype html><html><body>OK</body></html>\n```',
    promptTokens: 20,
    completionTokens: 45,
    totalTokens: 65,
    tokensPerSec: 88.4,
    timing: {
      ...createInitialTiming(1000),
      startedAt: 1010,
      headersAt: 1090,
      firstTokenAt: 1150,
      completedAt: 1650,
      queueMs: 10,
      requestMs: 80,
      ttfbMs: 140,
      downloadMs: 500,
      totalMs: 650,
    },
  },
  {
    targetId: 't2',
    modelName: 'llama3.2:latest',
    providerName: 'Ollama Local',
    providerKind: 'ollama',
    status: 'completed',
    output: 'Fast concise response.',
    promptTokens: 20,
    completionTokens: 22,
    totalTokens: 42,
    tokensPerSec: 42.1,
    timing: {
      ...createInitialTiming(1000),
      startedAt: 1015,
      headersAt: 1120,
      firstTokenAt: 1250,
      completedAt: 1750,
      queueMs: 15,
      requestMs: 105,
      ttfbMs: 235,
      downloadMs: 500,
      totalMs: 750,
    },
  },
];

describe('Workbench UI Components', () => {
  it('renders App with Prompt & Test Suites expanded and Configuration & History collapsed by default', () => {
    render(<App />);
    expect(screen.getByText('BenchForge')).toBeInTheDocument();

    const promptBtn = screen.getByRole('button', { name: /Prompt & Test Suites/i });
    const configBtn = screen.getByRole('button', { name: /Configuration & Models/i });
    const historyBtn = screen.getByRole('button', { name: /History & Cloud Sync/i });

    expect(promptBtn).toHaveAttribute('aria-expanded', 'true');
    expect(configBtn).toHaveAttribute('aria-expanded', 'false');
    expect(historyBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('switches between all 5 themes cleanly and updates document data-theme', () => {
    render(<App />);
    const selector = screen.getByLabelText('Theme selector');
    const themes = ['light', 'dark', 'sepia-light', 'sepia-dark', 'greenish-sepia'];

    for (const theme of themes) {
      fireEvent.change(selector, { target: { value: theme } });
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
    }
  });

  it('expands Configuration accordion and toggles execution mode', () => {
    render(<App />);
    const configBtn = screen.getByRole('button', { name: /Configuration & Models/i });
    fireEvent.click(configBtn);
    expect(configBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Execution Engine')).toBeInTheDocument();
  });

  it('renders ResultCard with tabs for Formatted, Raw, HTML Live Frame, and Audio', () => {
    render(<ResultCard result={mockResults[0]} onRetry={() => {}} />);
    expect(screen.getByText('gemini-4-hydrogen')).toBeInTheDocument();
    expect(screen.getByText('88.4 tok/s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
    expect(screen.getByText(/<!doctype html>/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /HTML Live Frame/i }));
    expect(screen.getByTitle(/HTML preview for gemini-4-hydrogen/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Audio \(TTS\)/i }));
    expect(screen.getByText(/Browser Speech Synthesis \(TTS\) is unavailable/i)).toBeInTheDocument();
  });

  it('renders TtsPlayer controls when speechSynthesis is available', () => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel: () => {},
        speak: () => {},
        pause: () => {},
        resume: () => {},
      },
    });
    render(<ResultCard result={mockResults[0]} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Audio \(TTS\)/i }));
    expect(screen.getByText(/Audio Playback/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Play Speech/i })).toBeInTheDocument();
  });

  it('renders error banner and troubleshooting advice on failed ResultCard', () => {
    const errResult: ModelRunResult = {
      ...mockResults[0],
      status: 'error',
      httpStatus: 504,
      error: 'Gateway Timeout',
      advice: 'Increase timeout budget.',
    };
    render(<ResultCard result={errResult} onRetry={() => {}} />);
    expect(screen.getByText(/HTTP 504 · Gateway Timeout/)).toBeInTheDocument();
    expect(screen.getByText('Increase timeout budget.')).toBeInTheDocument();
  });

  it('renders WaterfallView with sub-millisecond timing columns and sorting', () => {
    render(<WaterfallView results={mockResults} />);
    expect(screen.getByText('Network Timing Waterfall')).toBeInTheDocument();
    expect(screen.getByText('140.0 ms')).toBeInTheDocument();
    expect(screen.getByText('235.0 ms')).toBeInTheDocument();
  });

  it('renders DiffCompareView and switches between Side-by-Side and Unified modes', () => {
    render(<DiffCompareView results={mockResults} />);
    expect(screen.getByText(/Similarity/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unified Diff' }));
    expect(screen.getByText(/Fast/)).toBeInTheDocument();
  });

  it('renders CapabilityGraphView scatter plot and supports zoom controls', () => {
    render(<CapabilityGraphView results={mockResults} />);
    expect(screen.getByLabelText('Model latency vs capability scatter plot')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Zoom in'));
    expect(screen.getByText('125%')).toBeInTheDocument();
  });
});

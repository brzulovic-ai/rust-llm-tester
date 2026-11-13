import React, { useEffect, useState } from 'react';
import { Pause, Play, Square, Volume2 } from 'lucide-react';

interface TtsPlayerProps {
  text: string;
  modelName: string;
}

export const TtsPlayer: React.FC<TtsPlayerProps> = ({ text, modelName }) => {
  const [supported] = useState(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window
  );
  const [status, setStatus] = useState<'stopped' | 'playing' | 'paused'>('stopped');
  const [rate, setRate] = useState<number>(1.0);
  const [progressPct, setProgressPct] = useState<number>(0);

  useEffect(() => {
    return () => {
      if (supported) {
        window.speechSynthesis.cancel();
      }
    };
  }, [supported]);

  const cleanText = text
    .replace(/```[\s\S]*?```/g, ' Code block omitted. ')
    .replace(/[#*_`>]/g, '')
    .trim();

  const handlePlay = () => {
    if (!supported || !cleanText) return;

    if (status === 'paused') {
      window.speechSynthesis.resume();
      setStatus('playing');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = rate;
    utterance.onboundary = (event) => {
      if (cleanText.length > 0) {
        const pct = Math.min(100, Math.round((event.charIndex / cleanText.length) * 100));
        setProgressPct(pct);
      }
    };
    utterance.onend = () => {
      setStatus('stopped');
      setProgressPct(100);
    };
    utterance.onerror = () => {
      setStatus('stopped');
    };
    setProgressPct(0);
    setStatus('playing');
    window.speechSynthesis.speak(utterance);
  };

  const handlePause = () => {
    if (!supported) return;
    window.speechSynthesis.pause();
    setStatus('paused');
  };

  const handleStop = () => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setStatus('stopped');
    setProgressPct(0);
  };

  if (!supported) {
    return (
      <div
        className="p-4 rounded-lg border text-sm"
        style={{
          borderColor: 'var(--border-subtle)',
          backgroundColor: 'var(--bg-elevated)',
          color: 'var(--text-muted)',
        }}
      >
        Browser Speech Synthesis (TTS) is unavailable in this environment.
      </div>
    );
  }

  return (
    <div
      className="p-4 rounded-lg border space-y-3"
      style={{
        borderColor: 'var(--border-subtle)',
        backgroundColor: 'var(--bg-elevated)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          <Volume2 className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
          <span>Audio Playback</span>
          <span style={{ color: 'var(--text-muted)' }}>·</span>
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {modelName}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <span>Speed</span>
            <select
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              className="px-2 py-1 rounded border text-xs font-mono"
              style={{
                borderColor: 'var(--border-subtle)',
                backgroundColor: 'var(--bg-surface)',
                color: 'var(--text-primary)',
              }}
            >
              <option value={0.85}>0.85x</option>
              <option value={1}>1.0x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
            </select>
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {status !== 'playing' ? (
          <button
            type="button"
            onClick={handlePlay}
            disabled={!cleanText}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
            style={{
              backgroundColor: 'var(--accent-primary)',
              color: 'var(--accent-contrast)',
            }}
          >
            <Play className="w-3.5 h-3.5" />
            <span>{status === 'paused' ? 'Resume' : 'Play Speech'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handlePause}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap shrink-0"
            style={{
              borderColor: 'var(--border-strong)',
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-primary)',
            }}
          >
            <Pause className="w-3.5 h-3.5" />
            <span>Pause</span>
          </button>
        )}

        <button
          type="button"
          onClick={handleStop}
          disabled={status === 'stopped'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-secondary)',
          }}
        >
          <Square className="w-3.5 h-3.5" />
          <span>Stop</span>
        </button>

        <div className="flex-1 h-2 rounded-full overflow-hidden ml-2" style={{ backgroundColor: 'var(--bg-surface)' }}>
          <div
            className="h-full transition-all duration-150"
            style={{
              width: `${progressPct}%`,
              backgroundColor: 'var(--accent-primary)',
            }}
          />
        </div>
        <span className="text-xs font-mono tabular-nums w-10 text-right" style={{ color: 'var(--text-muted)' }}>
          {progressPct}%
        </span>
      </div>

      <p className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }}>
        {cleanText ? `${cleanText.slice(0, 180)}...` : 'No readable text available yet.'}
      </p>
    </div>
  );
};

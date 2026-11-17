import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { generateBenchforgeToml } from '../utils/tomlConfig';
import { DEFAULT_PROVIDERS, DEFAULT_SUPABASE_CONFIG, DEFAULT_TARGETS } from '../utils/historyStore';

describe('Rust TUI TOML Config & Modal', () => {
  it('generates valid benchforge.toml with concurrency up to 100, endpoints, and endpoint_files', () => {
    const toml = generateBenchforgeToml({
      executionConfig: {
        mode: 'parallel',
        concurrency: 100,
        timeoutSec: 240,
        stream: true,
        temperature: 0.5,
        maxTokens: 4096,
        topP: 0.9,
        seed: 7,
        endpointType: 'audio-transcriptions',
      },
      systemPrompt: {
        enabled: true,
        content: 'Be direct.',
        personaId: 'concise-expert',
        targetMode: 'all',
        targetModelIds: [],
      },
      theme: 'sepia-dark',
      supabaseConfig: DEFAULT_SUPABASE_CONFIG,
      providers: DEFAULT_PROVIDERS,
      targets: DEFAULT_TARGETS,
      endpointFiles: [
        {
          id: 'file-1',
          name: 'meeting.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 2048,
          endpointScope: 'audio-transcriptions',
          fieldName: 'file',
          base64Data: 'AAAA',
          enabled: true,
          addedAt: 1000,
        },
      ],
    });

    expect(toml).toContain('[execution]');
    expect(toml).toContain('concurrency = 100');
    expect(toml).toContain('endpoint_type = "audio-transcriptions"');
    expect(toml).toContain('timeout_sec = 240');
    expect(toml).toContain('seed = 7');
    expect(toml).toContain('theme = "sepia-dark"');
    expect(toml).toContain('[[providers]]');
    expect(toml).toContain('[[targets]]');
    expect(toml).toContain('[[endpoint_files]]');
    expect(toml).toContain('path = "meeting.mp3"');
    expect(toml).toContain('persona = "concise-expert"');
    expect(toml).toContain('base_url = "http://localhost:4100/v1"');
    expect(toml).toContain('api_key_env = "LITELLM_API_KEY"');
    expect(toml).toContain('qwen/qwen3-32b');
    expect(toml).toContain('llama-3.1-8b-instant');
  });

  it('omits inline secrets by default and includes them only when includeInlineSecrets is true', () => {
    const providers = [
      {
        ...DEFAULT_PROVIDERS[3],
        apiKey: 'sk-secret-key-999',
        customHeaders: { 'X-Org': 'org-secret' },
      },
    ];

    const redacted = generateBenchforgeToml({
      executionConfig: {
        mode: 'sequential',
        concurrency: 1,
        timeoutSec: 300,
        stream: true,
        temperature: 0.7,
        maxTokens: 1024,
        topP: 1,
      },
      systemPrompt: {
        enabled: false,
        content: '',
        personaId: null,
        targetMode: 'all',
        targetModelIds: [],
      },
      theme: 'dark',
      supabaseConfig: DEFAULT_SUPABASE_CONFIG,
      providers,
      targets: [],
      includeInlineSecrets: false,
    });
    expect(redacted).not.toContain('sk-secret-key-999');
    expect(redacted).not.toContain('org-secret');

    const withSecrets = generateBenchforgeToml({
      executionConfig: {
        mode: 'sequential',
        concurrency: 1,
        timeoutSec: 300,
        stream: true,
        temperature: 0.7,
        maxTokens: 1024,
        topP: 1,
      },
      systemPrompt: {
        enabled: false,
        content: '',
        personaId: null,
        targetMode: 'all',
        targetModelIds: [],
      },
      theme: 'dark',
      supabaseConfig: DEFAULT_SUPABASE_CONFIG,
      providers,
      targets: [],
      includeInlineSecrets: true,
    });
    expect(withSecrets).toContain('api_key = "sk-secret-key-999"');
    expect(withSecrets).toContain('"X-Org" = "org-secret"');
  });

  it('opens Rust TUI modal from toolbar and switches TUI preview tabs', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Rust TUI/i }));
    expect(screen.getByRole('dialog', { name: /Rust TUI and Configuration Export/i })).toBeInTheDocument();
    expect(screen.getByText(/Synced benchforge\.toml/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '1:Prompt' }));
    expect(screen.getByText(/Active Prompt \(press 'i' to edit\):/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close Rust TUI modal'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

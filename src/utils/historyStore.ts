import type {
  BenchmarkRunRecord,
  EndpointFileAttachment,
  ProviderEndpoint,
  SupabaseConfig,
  TargetModel,
  ThemeId,
} from '../types/benchmark';

export const HISTORY_STORAGE_KEY = 'llm_workbench_history_v1';
export const PROVIDERS_STORAGE_KEY = 'llm_workbench_providers_v1';
export const TARGETS_STORAGE_KEY = 'llm_workbench_targets_v1';
export const THEME_STORAGE_KEY = 'llm_workbench_theme_v1';
export const SUPABASE_STORAGE_KEY = 'llm_workbench_supabase_v1';
export const ENDPOINT_FILES_STORAGE_KEY = 'llm_workbench_endpoint_files_v1';
export const FONT_SIZE_STORAGE_KEY = 'llm_workbench_font_size_v1';

export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 22;

export const MAX_HISTORY_RUNS = 50;

export const DEFAULT_PROVIDERS: ProviderEndpoint[] = [
  {
    id: 'provider-gemini-builtin',
    name: 'Gemini Server Engine',
    kind: 'gemini-builtin',
    baseUrl: '/api/gemini/chat',
    apiKey: '',
    customHeaders: {},
    directBrowser: false,
    models: ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
  },
  {
    id: 'provider-ollama-local',
    name: 'Ollama Local',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    customHeaders: {},
    directBrowser: true,
    models: ['llama3.2:latest', 'qwen2.5-coder:7b'],
  },
  {
    id: 'provider-lmstudio-local',
    name: 'LM Studio',
    kind: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    customHeaders: {},
    directBrowser: true,
    models: ['local-model'],
  },
  {
    id: 'provider-groq',
    name: 'Groq Cloud',
    kind: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: '',
    customHeaders: {},
    directBrowser: false,
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen/qwen3-32b',
      'openai/gpt-oss-120b',
      'moonshotai/kimi-k2-instruct',
    ],
  },
  {
    id: 'provider-litellm',
    name: 'LiteLLM Proxy',
    kind: 'litellm',
    baseUrl: 'http://localhost:4100/v1',
    apiKey: '',
    customHeaders: {},
    directBrowser: false,
    models: [
      'gpt-4o-mini',
      'claude-3-7-sonnet',
      'gemini/gemini-2.5-flash',
      'deepseek/deepseek-chat',
    ],
  },
  {
    id: 'provider-vllm',
    name: 'vLLM Local',
    kind: 'vllm',
    baseUrl: 'http://localhost:8000/v1',
    apiKey: '',
    customHeaders: {},
    directBrowser: false,
    models: ['meta-llama/Llama-3.1-8B-Instruct'],
  },
];

export const DEFAULT_TARGETS: TargetModel[] = [
  {
    id: 'target-gemini-hydrogen',
    providerId: 'provider-gemini-builtin',
    providerName: 'Gemini Server Engine',
    providerKind: 'gemini-builtin',
    modelName: 'gemini-4-hydrogen',
    enabled: true,
  },
  {
    id: 'target-gemini-flash-lite',
    providerId: 'provider-gemini-builtin',
    providerName: 'Gemini Server Engine',
    providerKind: 'gemini-builtin',
    modelName: 'gemini-3.1-flash-lite',
    enabled: true,
  },
];

export function loadHistory(storage: Storage = window.localStorage): BenchmarkRunRecord[] {
  try {
    const raw = storage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_RUNS) : [];
  } catch {
    return [];
  }
}

export function saveRunToHistory(
  run: BenchmarkRunRecord,
  storage: Storage = window.localStorage
): BenchmarkRunRecord[] {
  const existing = loadHistory(storage).filter((item) => item.id !== run.id);
  const updated = [run, ...existing].slice(0, MAX_HISTORY_RUNS);
  try {
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Handle quota exceeded gracefully by trimming older entries
    const trimmed = updated.slice(0, 15);
    try {
      storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Ignore if storage is disabled
    }
  }
  return updated;
}

export function deleteRunFromHistory(
  id: string,
  storage: Storage = window.localStorage
): BenchmarkRunRecord[] {
  const updated = loadHistory(storage).filter((item) => item.id !== id);
  try {
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
  return updated;
}

export function clearHistory(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

export function loadProviders(storage: Storage = window.localStorage): ProviderEndpoint[] {
  try {
    const raw = storage.getItem(PROVIDERS_STORAGE_KEY);
    if (!raw) return DEFAULT_PROVIDERS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PROVIDERS;
  } catch {
    return DEFAULT_PROVIDERS;
  }
}

export function saveProviders(
  providers: ProviderEndpoint[],
  storage: Storage = window.localStorage
): void {
  try {
    storage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
  } catch {
    // Ignore
  }
}

export function loadTargets(storage: Storage = window.localStorage): TargetModel[] {
  try {
    const raw = storage.getItem(TARGETS_STORAGE_KEY);
    if (!raw) return DEFAULT_TARGETS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_TARGETS;
  } catch {
    return DEFAULT_TARGETS;
  }
}

export function saveTargets(
  targets: TargetModel[],
  storage: Storage = window.localStorage
): void {
  try {
    storage.setItem(TARGETS_STORAGE_KEY, JSON.stringify(targets));
  } catch {
    // Ignore
  }
}

export function loadTheme(storage: Storage = window.localStorage): ThemeId {
  try {
    const val = storage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    if (
      val === 'light' ||
      val === 'dark' ||
      val === 'sepia-light' ||
      val === 'sepia-dark' ||
      val === 'greenish-sepia'
    ) {
      return val;
    }
  } catch {
    // Ignore
  }
  return 'dark';
}

export function saveTheme(theme: ThemeId, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore
  }
}

export function loadFontSize(storage: Storage = window.localStorage): number {
  try {
    const raw = storage.getItem(FONT_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_FONT_SIZE;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(Math.round(parsed), MIN_FONT_SIZE), MAX_FONT_SIZE);
    }
  } catch {
    // Ignore
  }
  return DEFAULT_FONT_SIZE;
}

export function saveFontSize(fontSize: number, storage: Storage = window.localStorage): void {
  try {
    const clamped = Math.min(Math.max(Math.round(fontSize), MIN_FONT_SIZE), MAX_FONT_SIZE);
    storage.setItem(FONT_SIZE_STORAGE_KEY, String(clamped));
  } catch {
    // Ignore
  }
}

export const DEFAULT_SUPABASE_CONFIG: SupabaseConfig = {
  url: '',
  anonKey: '',
  tableName: 'benchmark_runs',
  autoSync: false,
};

export function loadSupabaseConfig(storage: Storage = window.localStorage): SupabaseConfig {
  try {
    const raw = storage.getItem(SUPABASE_STORAGE_KEY);
    if (!raw) return DEFAULT_SUPABASE_CONFIG;
    return { ...DEFAULT_SUPABASE_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SUPABASE_CONFIG;
  }
}

export function saveSupabaseConfig(
  config: SupabaseConfig,
  storage: Storage = window.localStorage
): void {
  try {
    storage.setItem(SUPABASE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore
  }
}

export function loadEndpointFiles(storage: Storage = window.localStorage): EndpointFileAttachment[] {
  try {
    const raw = storage.getItem(ENDPOINT_FILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEndpointFiles(
  files: EndpointFileAttachment[],
  storage: Storage = window.localStorage
): void {
  try {
    storage.setItem(ENDPOINT_FILES_STORAGE_KEY, JSON.stringify(files));
  } catch {
    // Ignore quota exceeded for large binary files; kept in memory for current session
  }
}


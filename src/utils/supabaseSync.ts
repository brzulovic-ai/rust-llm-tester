import type { BenchmarkRunRecord, SupabaseConfig, SyncLogEntry } from '../types/benchmark';

export const SUPABASE_TABLE_SQL = `create table if not exists benchmark_runs (
  id text primary key,
  title text not null,
  created_at timestamptz not null default now(),
  prompt text not null,
  suite_name text,
  payload jsonb not null
);`;

export async function testSupabaseConnection(config: SupabaseConfig): Promise<SyncLogEntry> {
  const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (!config.url.trim() || !config.anonKey.trim()) {
    return {
      id,
      timestamp: Date.now(),
      action: 'test',
      status: 'error',
      message: 'Supabase Project URL and Anon/Service Key are required.',
    };
  }

  try {
    const res = await fetch('/api/supabase/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supabaseUrl: config.url,
        supabaseKey: config.anonKey,
        tableName: config.tableName || 'benchmark_runs',
        action: 'test',
      }),
    });
    const data = (await res.json()) as { ok?: boolean; status?: number; message?: string; error?: string };
    return {
      id,
      timestamp: Date.now(),
      action: 'test',
      status: res.ok && data.ok ? 'success' : 'error',
      httpStatus: data.status ?? res.status,
      message: data.message || data.error || `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    const errObj = err as { message?: string };
    return {
      id,
      timestamp: Date.now(),
      action: 'test',
      status: 'error',
      message: errObj?.message || 'Connection test failed',
    };
  }
}

export async function pushRunToSupabase(
  config: SupabaseConfig,
  run: BenchmarkRunRecord
): Promise<SyncLogEntry> {
  const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (!config.url.trim() || !config.anonKey.trim()) {
    return {
      id,
      timestamp: Date.now(),
      action: 'push',
      status: 'error',
      message: 'Missing Supabase credentials.',
    };
  }

  try {
    const row = {
      id: run.id,
      title: run.title,
      created_at: new Date(run.createdAt).toISOString(),
      prompt: run.prompt,
      suite_name: run.suiteName ?? null,
      payload: run,
    };

    const res = await fetch('/api/supabase/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supabaseUrl: config.url,
        supabaseKey: config.anonKey,
        tableName: config.tableName || 'benchmark_runs',
        action: 'push',
        payload: row,
      }),
    });

    const data = (await res.json()) as { ok?: boolean; status?: number; error?: string };
    return {
      id,
      timestamp: Date.now(),
      action: 'push',
      status: res.ok && data.ok ? 'success' : 'error',
      httpStatus: data.status ?? res.status,
      message:
        res.ok && data.ok
          ? `Synced run "${run.title}" (${run.results.length} models)`
          : data.error || `Sync failed (HTTP ${res.status})`,
    };
  } catch (err: unknown) {
    const errObj = err as { message?: string };
    return {
      id,
      timestamp: Date.now(),
      action: 'push',
      status: 'error',
      message: errObj?.message || 'Push sync failed',
    };
  }
}

export async function pullRunsFromSupabase(
  config: SupabaseConfig
): Promise<{ log: SyncLogEntry; runs: BenchmarkRunRecord[] }> {
  const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (!config.url.trim() || !config.anonKey.trim()) {
    return {
      log: {
        id,
        timestamp: Date.now(),
        action: 'pull',
        status: 'error',
        message: 'Missing Supabase credentials.',
      },
      runs: [],
    };
  }

  try {
    const res = await fetch('/api/supabase/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supabaseUrl: config.url,
        supabaseKey: config.anonKey,
        tableName: config.tableName || 'benchmark_runs',
        action: 'pull',
      }),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      status?: number;
      data?: Array<{ payload?: BenchmarkRunRecord }>;
      error?: string;
    };

    if (!res.ok || !data.ok) {
      return {
        log: {
          id,
          timestamp: Date.now(),
          action: 'pull',
          status: 'error',
          httpStatus: data.status ?? res.status,
          message: data.error || `Pull failed (HTTP ${res.status})`,
        },
        runs: [],
      };
    }

    const runs = (data.data ?? [])
      .map((row) => row.payload)
      .filter((p): p is BenchmarkRunRecord => Boolean(p && p.id && Array.isArray(p.results)));

    return {
      log: {
        id,
        timestamp: Date.now(),
        action: 'pull',
        status: 'success',
        httpStatus: data.status ?? res.status,
        message: `Fetched ${runs.length} benchmark runs from Supabase`,
      },
      runs,
    };
  } catch (err: unknown) {
    const errObj = err as { message?: string };
    return {
      log: {
        id,
        timestamp: Date.now(),
        action: 'pull',
        status: 'error',
        message: errObj?.message || 'Pull failed',
      },
      runs: [],
    };
  }
}

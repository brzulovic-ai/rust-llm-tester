use crate::config::{BenchConfig, SupabaseConfig};
use crate::engine::ModelRunResult;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkRunRecord {
    pub id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub prompt: String,
    pub results: Vec<ModelRunResult>,
}

fn history_file_path() -> PathBuf {
    BenchConfig::data_dir().join("history.json")
}

pub fn load_history(limit: usize) -> Vec<BenchmarkRunRecord> {
    let path = history_file_path();
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut list = serde_json::from_str::<Vec<BenchmarkRunRecord>>(&raw).unwrap_or_default();
    list.truncate(limit);
    list
}

pub fn save_run_to_history(run: BenchmarkRunRecord, limit: usize) -> Result<Vec<BenchmarkRunRecord>> {
    let mut existing = load_history(limit);
    existing.retain(|r| r.id != run.id);
    existing.insert(0, run);
    existing.truncate(limit.max(1));

    let path = history_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(&existing)?)?;
    Ok(existing)
}

fn escape_csv(val: &str) -> String {
    if val.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", val.replace('"', "\"\""))
    } else {
        val.to_string()
    }
}

pub fn build_csv(results: &[ModelRunResult], prompt: &str) -> String {
    let mut lines = vec![
        "Model,Provider,Status,Queue_ms,Request_ms,TTFB_ms,Download_ms,Total_ms,Speed_tok_s,Prompt_Tokens,Completion_Tokens,Total_Tokens,Error,Prompt,Output".to_string(),
    ];
    for r in results {
        let ttfb = r
            .timing
            .ttfb_ms
            .map(|v| format!("{:.1}", v))
            .unwrap_or_default();
        let row = [
            escape_csv(&r.model_name),
            escape_csv(&r.provider_name),
            escape_csv(r.status.label()),
            format!("{:.1}", r.timing.queue_ms),
            format!("{:.1}", r.timing.request_ms),
            ttfb,
            format!("{:.1}", r.timing.download_ms),
            format!("{:.1}", r.timing.total_ms),
            format!("{:.1}", r.tokens_per_sec),
            r.prompt_tokens.to_string(),
            r.completion_tokens.to_string(),
            r.total_tokens.to_string(),
            escape_csv(r.error.as_deref().unwrap_or("")),
            escape_csv(prompt),
            escape_csv(&r.output),
        ]
        .join(",");
        lines.push(row);
    }
    lines.join("\n")
}

pub fn export_bundle(dir: &Path, run: &BenchmarkRunRecord) -> Result<(PathBuf, PathBuf)> {
    fs::create_dir_all(dir)?;
    let ts = run.created_at.timestamp();
    let json_path = dir.join(format!("benchmark-{}.json", ts));
    let csv_path = dir.join(format!("benchmark-{}.csv", ts));

    fs::write(&json_path, serde_json::to_string_pretty(run)?)?;
    fs::write(&csv_path, build_csv(&run.results, &run.prompt))?;
    Ok((json_path, csv_path))
}

pub async fn push_run_supabase(sb: &SupabaseConfig, run: &BenchmarkRunRecord) -> Result<String> {
    let url = sb.url.trim().trim_end_matches('/');
    let Some(key) = sb.resolve_key() else {
        anyhow::bail!("Supabase key missing (check supabase.anon_key_env)");
    };
    if url.is_empty() {
        anyhow::bail!("Supabase URL is empty");
    }

    let endpoint = format!("{}/rest/v1/{}", url, sb.table_name);
    let payload = serde_json::json!({
        "id": run.id,
        "title": run.title,
        "created_at": run.created_at.to_rfc3339(),
        "prompt": run.prompt,
        "payload": run,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&endpoint)
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .header("Prefer", "resolution=merge-duplicates")
        .json(&payload)
        .send()
        .await?;

    if resp.status().is_success() {
        Ok(format!("Synced '{}' to Supabase ({})", run.title, resp.status()))
    } else {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("Supabase HTTP error: {}", txt)
    }
}

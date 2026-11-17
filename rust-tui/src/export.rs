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

#[derive(Debug, Deserialize)]
struct WebWrappedExport {
    run: serde_json::Value,
}

fn value_as_string(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str], fallback: &str) -> String {
    for k in keys {
        if let Some(v) = obj.get(*k).and_then(|v| v.as_str()) {
            return v.to_string();
        }
    }
    fallback.to_string()
}

fn value_as_u32(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> u32 {
    for k in keys {
        if let Some(v) = obj.get(*k).and_then(|v| v.as_u64()) {
            return v as u32;
        }
    }
    0
}

fn value_as_f64(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(v) = obj.get(*k).and_then(|v| v.as_f64()) {
            if v.is_finite() {
                return Some(v);
            }
        }
    }
    None
}

fn parse_status_lossy(raw: &str) -> crate::engine::RunStatus {
    use crate::engine::RunStatus;
    match raw.trim().to_ascii_lowercase().as_str() {
        "idle" => RunStatus::Idle,
        "queued" => RunStatus::Queued,
        "connecting" => RunStatus::Connecting,
        "streaming" => RunStatus::Streaming,
        "completed" => RunStatus::Completed,
        "aborted" => RunStatus::Aborted,
        "error" | "failed" => RunStatus::Error,
        _ => RunStatus::Completed,
    }
}

/// Imports a benchmark JSON file from either Rust TUI (`benchmark-<ts>.json`),
/// Web `{ "run": ... }` exports, or `history.json` arrays.
pub fn import_bundle_json(raw: &str) -> Result<BenchmarkRunRecord> {
    if let Ok(record) = serde_json::from_str::<BenchmarkRunRecord>(raw) {
        return Ok(record);
    }
    if let Ok(list) = serde_json::from_str::<Vec<BenchmarkRunRecord>>(raw) {
        if let Some(first) = list.into_iter().next() {
            return Ok(first);
        }
        anyhow::bail!("Imported JSON array contains no benchmark runs");
    }

    let root: serde_json::Value = serde_json::from_str(raw)?;
    let run_val = if let Ok(wrapped) = serde_json::from_value::<WebWrappedExport>(root.clone()) {
        wrapped.run
    } else if root.is_array() {
        root.as_array()
            .and_then(|arr| arr.first())
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Imported JSON array is empty"))?
    } else {
        root
    };

    if let Ok(record) = serde_json::from_value::<BenchmarkRunRecord>(run_val.clone()) {
        return Ok(record);
    }

    let obj = run_val
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Expected JSON benchmark run object"))?;
    let raw_results = obj
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing \"results\" array in benchmark JSON"))?;

    let created_at = if let Some(ms) = obj
        .get("createdAt")
        .or_else(|| obj.get("created_at"))
        .and_then(|v| v.as_i64())
    {
        DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_else(Utc::now)
    } else if let Some(iso) = obj
        .get("createdAt")
        .or_else(|| obj.get("created_at"))
        .and_then(|v| v.as_str())
    {
        DateTime::parse_from_rfc3339(iso)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now())
    } else {
        Utc::now()
    };

    let mut results = Vec::with_capacity(raw_results.len());
    for (idx, item) in raw_results.iter().enumerate() {
        let Some(r) = item.as_object() else { continue };
        let timing_obj = r.get("timing").and_then(|v| v.as_object());
        let queue_ms = timing_obj
            .and_then(|t| value_as_f64(t, &["queueMs", "queue_ms"]))
            .unwrap_or(0.0);
        let request_ms = timing_obj
            .and_then(|t| value_as_f64(t, &["requestMs", "request_ms"]))
            .unwrap_or(0.0);
        let ttfb_ms = timing_obj.and_then(|t| value_as_f64(t, &["ttfbMs", "ttfb_ms"]));
        let download_ms = timing_obj
            .and_then(|t| value_as_f64(t, &["downloadMs", "download_ms"]))
            .unwrap_or(0.0);
        let total_ms = timing_obj
            .and_then(|t| value_as_f64(t, &["totalMs", "total_ms"]))
            .unwrap_or(0.0);
        let offset_ms = timing_obj
            .and_then(|t| value_as_f64(t, &["offset_ms", "enqueuedAt"]))
            .unwrap_or(0.0);

        let fallback_id = format!("imported-{}", idx);
        let fallback_model = format!("Model {}", idx + 1);
        let status_raw = value_as_string(r, &["status"], "completed");

        results.push(ModelRunResult {
            target_id: value_as_string(r, &["targetId", "target_id"], &fallback_id),
            model_name: value_as_string(r, &["modelName", "model_name"], &fallback_model),
            provider_name: value_as_string(r, &["providerName", "provider_name"], "Imported"),
            status: parse_status_lossy(&status_raw),
            output: value_as_string(r, &["output"], ""),
            prompt_tokens: value_as_u32(r, &["promptTokens", "prompt_tokens"]),
            completion_tokens: value_as_u32(r, &["completionTokens", "completion_tokens"]),
            total_tokens: value_as_u32(r, &["totalTokens", "total_tokens"]),
            tokens_per_sec: value_as_f64(r, &["tokensPerSec", "tokens_per_sec"]).unwrap_or(0.0),
            timing: crate::engine::TimingMetrics {
                offset_ms,
                queue_ms,
                request_ms,
                ttfb_ms,
                download_ms,
                total_ms,
            },
            http_status: r
                .get("httpStatus")
                .or_else(|| r.get("http_status"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u16),
            error: r.get("error").and_then(|v| v.as_str()).map(str::to_string),
            advice: r.get("advice").and_then(|v| v.as_str()).map(str::to_string),
        });
    }

    Ok(BenchmarkRunRecord {
        id: value_as_string(obj, &["id"], &format!("imported-{}", Utc::now().timestamp_millis())),
        title: value_as_string(obj, &["title"], "Imported Benchmark"),
        created_at,
        prompt: value_as_string(obj, &["prompt"], ""),
        results,
    })
}

pub fn load_latest_export(dir: &Path) -> Result<(PathBuf, BenchmarkRunRecord)> {
    if !dir.exists() {
        anyhow::bail!("No exports directory found ({})", dir.display());
    }
    let mut json_files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            json_files.push((modified, path));
        }
    }
    json_files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let (_, latest_path) = json_files
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No *.json benchmark exports in {}", dir.display()))?;
    let raw = fs::read_to_string(&latest_path)?;
    let record = import_bundle_json(&raw)?;
    Ok((latest_path, record))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_web_wrapped_and_native_benchmark_json() {
        let web_json = r#"{
          "exportedAt": "2026-11-17T00:00:00.000Z",
          "run": {
            "id": "export-1",
            "title": "Free Models Ping",
            "createdAt": 1760000000000,
            "prompt": "Reply with pong",
            "results": [
              {
                "targetId": "t-1",
                "modelName": "llama-3.3-70b-free",
                "providerName": "OpenRouter",
                "status": "completed",
                "output": "pong",
                "promptTokens": 4,
                "completionTokens": 1,
                "totalTokens": 5,
                "tokensPerSec": 55.5,
                "httpStatus": 200,
                "timing": {
                  "queueMs": 2,
                  "requestMs": 30,
                  "ttfbMs": 45,
                  "downloadMs": 12,
                  "totalMs": 89
                }
              }
            ]
          }
        }"#;
        let parsed = import_bundle_json(web_json).expect("import web json");
        assert_eq!(parsed.title, "Free Models Ping");
        assert_eq!(parsed.results.len(), 1);
        assert_eq!(parsed.results[0].model_name, "llama-3.3-70b-free");
        assert_eq!(parsed.results[0].http_status, Some(200));
        assert_eq!(parsed.results[0].timing.ttfb_ms, Some(45.0));

        let native_json = serde_json::to_string_pretty(&parsed).expect("serialize native");
        let reparsed = import_bundle_json(&native_json).expect("reparse native");
        assert_eq!(reparsed.id, "export-1");
        assert_eq!(reparsed.results[0].output, "pong");
    }
}

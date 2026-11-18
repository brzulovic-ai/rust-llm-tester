use crate::config::{
    BenchConfig, EndpointType, ExecutionMode, ProviderConfig, SystemTargetMode, TargetConfig,
};
use crate::suites::lookup_persona;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Idle,
    Queued,
    Connecting,
    Streaming,
    Completed,
    Error,
    Aborted,
}

impl RunStatus {
    pub fn label(self) -> &'static str {
        match self {
            RunStatus::Idle => "Idle",
            RunStatus::Queued => "Queued",
            RunStatus::Connecting => "Connecting",
            RunStatus::Streaming => "Streaming",
            RunStatus::Completed => "Completed",
            RunStatus::Error => "Failed",
            RunStatus::Aborted => "Aborted",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimingBreakdown {
    pub offset_ms: f64,
    pub queue_ms: f64,
    pub request_ms: f64,
    pub ttfb_ms: Option<f64>,
    pub download_ms: f64,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusCategory {
    Ok,
    Pending,
    Aborted,
    RateLimit,
    Quota,
    Auth,
    NotFound,
    Timeout,
    Server,
    Error,
}

fn extract_http_code_from_text(text: &str) -> Option<u16> {
    for tok in text.split(|c: char| !c.is_ascii_digit()) {
        if tok.len() == 3 {
            if let Ok(n) = tok.parse::<u16>() {
                if (400..=599).contains(&n) || n == 200 {
                    return Some(n);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRunResult {
    pub target_id: String,
    pub model_name: String,
    pub provider_name: String,
    pub status: RunStatus,
    pub output: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub tokens_per_sec: f64,
    pub timing: TimingBreakdown,
    pub http_status: Option<u16>,
    pub error: Option<String>,
    pub advice: Option<String>,
}

impl ModelRunResult {
    pub fn classify_status(&self) -> (StatusCategory, String) {
        let code = self.http_status.or_else(|| {
            self.error
                .as_deref()
                .and_then(extract_http_code_from_text)
        });

        match self.status {
            RunStatus::Completed => {
                let c = code.unwrap_or(200);
                (StatusCategory::Ok, format!("{} OK", c))
            }
            RunStatus::Idle | RunStatus::Queued | RunStatus::Connecting | RunStatus::Streaming => {
                (StatusCategory::Pending, "-".to_string())
            }
            RunStatus::Aborted => (StatusCategory::Aborted, "ABORTED".to_string()),
            RunStatus::Error => {
                let lower = format!(
                    "{} {}",
                    self.error.as_deref().unwrap_or(""),
                    self.advice.as_deref().unwrap_or("")
                )
                .to_lowercase();

                if code == Some(429)
                    || lower.contains("rate limit")
                    || lower.contains("rate_limit")
                    || lower.contains("too many requests")
                {
                    let c = code.unwrap_or(429);
                    return (StatusCategory::RateLimit, format!("{} RATE LIM", c));
                }
                if code == Some(402)
                    || lower.contains("quota")
                    || lower.contains("credit")
                    || lower.contains("billing")
                {
                    let c = code.unwrap_or(402);
                    return (StatusCategory::Quota, format!("{} QUOTA", c));
                }
                if code == Some(401)
                    || code == Some(403)
                    || lower.contains("unauthorized")
                    || lower.contains("forbidden")
                    || lower.contains("invalid api key")
                {
                    let c = code.unwrap_or(401);
                    return (StatusCategory::Auth, format!("{} AUTH", c));
                }
                if code == Some(404)
                    || lower.contains("not found")
                    || lower.contains("does not exist")
                {
                    let c = code.unwrap_or(404);
                    return (StatusCategory::NotFound, format!("{} NO MODEL", c));
                }
                if code == Some(408)
                    || code == Some(504)
                    || lower.contains("timed out")
                    || lower.contains("timeout")
                {
                    let label = match code {
                        Some(c) => format!("{} TIMEOUT", c),
                        None => "TIMEOUT".to_string(),
                    };
                    return (StatusCategory::Timeout, label);
                }
                if let Some(c) = code {
                    if c >= 500 {
                        return (StatusCategory::Server, format!("{} SERVER", c));
                    }
                    return (StatusCategory::Error, format!("{} ERR", c));
                }
                (StatusCategory::Error, "NET ERR".to_string())
            }
        }
    }
}

#[derive(Debug, Clone)]
pub enum EngineEvent {
    Update(ModelRunResult),
    BatchFinished,
    ModelsRefreshed {
        provider_id: String,
        provider_name: String,
        result: Result<Vec<String>, String>,
    },
}

#[derive(Debug, Deserialize)]
struct SsePayload {
    error: Option<serde_json::Value>,
    choices: Option<Vec<SseChoice>>,
    usage: Option<SseUsage>,
}

#[derive(Debug, Deserialize)]
struct SseChoice {
    delta: Option<SseDelta>,
    message: Option<SseMessage>,
}

#[derive(Debug, Deserialize)]
struct SseDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SseUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

pub fn estimate_tokens(text: &str) -> u64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    ((trimmed.len() as f64) / 3.8).ceil().max(1.0) as u64
}

pub fn resolve_system_prompt(target: &TargetConfig, cfg: &BenchConfig) -> Option<String> {
    if let Some(ref ov) = target.system_prompt_override {
        if !ov.trim().is_empty() {
            return Some(ov.trim().to_string());
        }
    }
    if !cfg.system_prompt.enabled {
        return None;
    }
    let body = if !cfg.system_prompt.content.trim().is_empty() {
        cfg.system_prompt.content.trim().to_string()
    } else if let Some(ref p_id) = cfg.system_prompt.persona {
        lookup_persona(p_id)?.prompt.to_string()
    } else {
        return None;
    };

    match cfg.system_prompt.target_mode {
        SystemTargetMode::All => Some(body),
        SystemTargetMode::Specific => {
            if cfg
                .system_prompt
                .target_models
                .iter()
                .any(|m| m == &target.id || m == &target.model)
            {
                Some(body)
            } else {
                None
            }
        }
    }
}

pub fn build_advice(status: Option<u16>, err_text: &str, base_url: &str) -> String {
    if err_text.contains("timed out") || status == Some(504) || status == Some(408) {
        return "Increase execution.timeout_sec in benchforge.toml (up to 600s).".to_string();
    }
    if err_text.contains("Connection refused") || err_text.contains("error trying to connect") {
        return format!(
            "Ensure the local/remote server at {} is running and reachable.",
            base_url
        );
    }
    match status {
        Some(400) => "Bad request (400). Verify model parameters (temperature/top_p/max_tokens) or payload format.".to_string(),
        Some(401 | 403) => "Verify api_key_env or custom_headers Authorization token.".to_string(),
        Some(404) => format!("Verify base_url ({}) includes /v1 and model ID exists.", base_url),
        Some(429) => "Rate limited (429). Lower execution.concurrency or retry.".to_string(),
        _ => "Inspect provider base_url, model name, and network connectivity.".to_string(),
    }
}

pub fn model_disallows_sampling_params(model: &str) -> bool {
    let clean = model
        .trim()
        .to_ascii_lowercase()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();
    clean == "o1"
        || clean.starts_with("o1-")
        || clean == "o3"
        || clean.starts_with("o3-")
        || clean == "o4"
        || clean.starts_with("o4-")
        || clean == "gpt-5"
        || clean.starts_with("gpt-5-")
        || clean.starts_with("gpt-5.")
        || clean == "deepseek-reasoner"
}

pub fn strip_rejected_sampling_params(payload: &mut serde_json::Value, err_body: &str) -> bool {
    let lower = err_body.to_ascii_lowercase();
    let mentions_temp = lower.contains("temperature")
        || lower.contains("sampling")
        || (lower.contains("unsupported") && lower.contains("parameter"));
    let mentions_top_p = lower.contains("top_p") || lower.contains("topp");
    let mentions_max_tokens = lower.contains("max_tokens")
        && (lower.contains("max_completion_tokens")
            || lower.contains("unsupported")
            || lower.contains("not supported"));

    let Some(obj) = payload.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if (mentions_temp || mentions_top_p) && obj.remove("temperature").is_some() {
        changed = true;
    }
    if (mentions_temp || mentions_top_p) && obj.remove("top_p").is_some() {
        changed = true;
    }
    if mentions_max_tokens {
        if let Some(max_tok) = obj.remove("max_tokens") {
            obj.insert("max_completion_tokens".to_string(), max_tok);
            changed = true;
        }
    }
    changed
}

#[derive(Debug, Deserialize)]
struct ModelsListResponse {
    data: Option<Vec<ModelEntry>>,
    models: Option<Vec<ModelEntry>>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: Option<String>,
    name: Option<String>,
}

pub async fn discover_provider_models(provider: &ProviderConfig) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(key) = provider.resolve_api_key() {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", key)) {
            headers.insert(AUTHORIZATION, val);
        }
    }
    for (k, v) in &provider.custom_headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }

    let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Network error calling {}: {}", url, e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {} from {}: {}",
            status.as_u16(),
            url,
            body.chars().take(180).collect::<String>()
        ));
    }

    let parsed = resp
        .json::<ModelsListResponse>()
        .await
        .map_err(|e| format!("Invalid /models JSON from {}: {}", url, e))?;

    let mut out = Vec::new();
    for entry in parsed.data.unwrap_or_default().into_iter().chain(parsed.models.unwrap_or_default()) {
        if let Some(id) = entry.id.or(entry.name) {
            let trimmed = id.trim().to_string();
            if !trimmed.is_empty() && !out.contains(&trimmed) {
                out.push(trimmed);
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn spawn_refresh_provider_models(
    provider: ProviderConfig,
    tx: mpsc::UnboundedSender<EngineEvent>,
) {
    tokio::spawn(async move {
        let result = discover_provider_models(&provider).await;
        let _ = tx.send(EngineEvent::ModelsRefreshed {
            provider_id: provider.id,
            provider_name: provider.name,
            result,
        });
    });
}

pub fn spawn_benchmark_batch(
    cfg: BenchConfig,
    targets: Vec<TargetConfig>,
    prompt: String,
    tx: mpsc::UnboundedSender<EngineEvent>,
    abort_rx: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        let concurrency = match cfg.execution.mode {
            ExecutionMode::Sequential => 1,
            ExecutionMode::Parallel => cfg.execution.concurrency.clamp(1, 100),
        };
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let batch_start = Instant::now();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let mut handles = Vec::with_capacity(targets.len());

        for target in targets {
            let provider = cfg.find_provider(&target.provider_id).cloned();
            let cfg_clone = cfg.clone();
            let prompt_clone = prompt.clone();
            let tx_clone = tx.clone();
            let sem = semaphore.clone();
            let mut target_abort = abort_rx.clone();
            let client_clone = client.clone();

            let handle = tokio::spawn(async move {
                let Some(provider) = provider else {
                    let _ = tx_clone.send(EngineEvent::Update(ModelRunResult {
                        target_id: target.id,
                        model_name: target.model,
                        provider_name: target.provider_id,
                        status: RunStatus::Error,
                        output: String::new(),
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                        tokens_per_sec: 0.0,
                        timing: TimingBreakdown::default(),
                        http_status: None,
                        error: Some("Provider ID not found in config".to_string()),
                        advice: Some("Check [[providers]] in benchforge.toml".to_string()),
                    }));
                    return;
                };

                let _ = tx_clone.send(EngineEvent::Update(ModelRunResult {
                    target_id: target.id.clone(),
                    model_name: target.model.clone(),
                    provider_name: provider.name.clone(),
                    status: RunStatus::Queued,
                    output: String::new(),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    tokens_per_sec: 0.0,
                    timing: TimingBreakdown::default(),
                    http_status: None,
                    error: None,
                    advice: None,
                }));

                let permit = tokio::select! {
                    p = sem.acquire_owned() => p.ok(),
                    _ = target_abort.changed() => None,
                };

                let Some(_permit) = permit else {
                    let _ = tx_clone.send(EngineEvent::Update(ModelRunResult {
                        target_id: target.id,
                        model_name: target.model,
                        provider_name: provider.name,
                        status: RunStatus::Aborted,
                        output: String::new(),
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                        tokens_per_sec: 0.0,
                        timing: TimingBreakdown::default(),
                        http_status: None,
                        error: Some("Aborted before dispatch".to_string()),
                        advice: None,
                    }));
                    return;
                };

                if *target_abort.borrow() {
                    return;
                }

                run_single_target(
                    client_clone,
                    batch_start,
                    &cfg_clone,
                    &target,
                    &provider,
                    &prompt_clone,
                    &tx_clone,
                    &mut target_abort,
                )
                .await;
            });

            handles.push(handle);
        }

        for h in handles {
            let _ = h.await;
        }
        let _ = tx.send(EngineEvent::BatchFinished);
    });
}

pub fn resolve_endpoint_url(
    base_url: &str,
    endpoint_type: EndpointType,
    custom_endpoint: &str,
) -> String {
    let clean_base = base_url.trim().trim_end_matches('/');
    if endpoint_type == EndpointType::Custom {
        let raw = custom_endpoint.trim();
        if raw.is_empty() {
            return format!("{}/chat/completions", clean_base);
        }
        if raw.starts_with("http://") || raw.starts_with("https://") {
            return raw.to_string();
        }
        let rel = if raw.starts_with('/') {
            raw.to_string()
        } else {
            format!("/{}", raw)
        };
        if clean_base.ends_with("/v1") && (rel == "/v1" || rel.starts_with("/v1/")) {
            return format!("{}{}", clean_base, &rel[3..]);
        }
        return format!("{}{}", clean_base, rel);
    }
    format!("{}{}", clean_base, endpoint_type.suffix())
}

fn build_multipart_body(
    boundary: &str,
    fields: &[(&str, &str)],
    files: &[(&str, &str, &str, &[u8])],
) -> Vec<u8> {
    let mut buf = Vec::new();
    for (name, val) in fields {
        buf.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        buf.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{}\"\r\n\r\n", name).as_bytes(),
        );
        buf.extend_from_slice(val.as_bytes());
        buf.extend_from_slice(b"\r\n");
    }
    for (field_name, filename, mime_type, bytes) in files {
        buf.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        buf.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
                field_name, filename
            )
            .as_bytes(),
        );
        buf.extend_from_slice(format!("Content-Type: {}\r\n\r\n", mime_type).as_bytes());
        buf.extend_from_slice(bytes);
        buf.extend_from_slice(b"\r\n");
    }
    buf.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());
    buf
}

#[allow(clippy::too_many_arguments)]
async fn run_single_target(
    client: reqwest::Client,
    batch_start: Instant,
    cfg: &BenchConfig,
    target: &TargetConfig,
    provider: &ProviderConfig,
    prompt: &str,
    tx: &mpsc::UnboundedSender<EngineEvent>,
    abort_rx: &mut watch::Receiver<bool>,
) {
    let dispatched_at = Instant::now();
    let queue_ms = dispatched_at.duration_since(batch_start).as_secs_f64() * 1000.0;
    let sys_prompt = resolve_system_prompt(target, cfg);
    let endpoint_type = cfg.execution.endpoint_type;
    let matched_files = cfg.matching_endpoint_files();

    // Inject text attachments into prompt for text endpoints when present
    let mut effective_prompt = prompt.to_string();
    if matches!(
        endpoint_type,
        EndpointType::ChatCompletions | EndpointType::Responses | EndpointType::Embeddings
    ) && !matched_files.is_empty()
    {
        let mut attachment_blocks = Vec::new();
        for f in &matched_files {
            if let Ok(raw) = tokio::fs::read(&f.path).await {
                let text = String::from_utf8_lossy(&raw);
                let snippet: String = text.chars().take(16000).collect();
                let name = std::path::Path::new(&f.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&f.path);
                attachment_blocks.push(format!("[Attached File: {}]\n{}", name, snippet));
            }
        }
        if !attachment_blocks.is_empty() {
            if effective_prompt.trim().is_empty() {
                effective_prompt = attachment_blocks.join("\n\n");
            } else {
                effective_prompt = format!("{}\n\n{}", effective_prompt, attachment_blocks.join("\n\n"));
            }
        }
    }

    let mut messages = Vec::new();
    let mut est_prompt_tokens = estimate_tokens(&effective_prompt);
    if let Some(ref sys) = sys_prompt {
        est_prompt_tokens += estimate_tokens(sys);
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": effective_prompt }));

    let mut headers = HeaderMap::new();
    if let Some(key) = provider.resolve_api_key() {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", key)) {
            headers.insert(AUTHORIZATION, val);
        }
    }
    for (k, v) in &provider.custom_headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }

    let mut result = ModelRunResult {
        target_id: target.id.clone(),
        model_name: target.model.clone(),
        provider_name: provider.name.clone(),
        status: RunStatus::Connecting,
        output: String::new(),
        prompt_tokens: est_prompt_tokens,
        completion_tokens: 0,
        total_tokens: est_prompt_tokens,
        tokens_per_sec: 0.0,
        timing: TimingBreakdown {
            offset_ms: 0.0,
            queue_ms,
            ..Default::default()
        },
        http_status: None,
        error: None,
        advice: None,
    };
    let _ = tx.send(EngineEvent::Update(result.clone()));

    let url = resolve_endpoint_url(&provider.base_url, endpoint_type, &cfg.execution.custom_endpoint);
    let timeout_dur = Duration::from_secs(cfg.execution.timeout_sec.clamp(5, 600));
    let use_multipart = matches!(
        endpoint_type,
        EndpointType::AudioTranscriptions | EndpointType::AudioTranslations
    ) || (endpoint_type == EndpointType::Custom && !matched_files.is_empty());

    let disallow_sampling = model_disallows_sampling_params(&target.model);
    let mut json_body_opt: Option<serde_json::Value> = None;

    let request_builder = if use_multipart {
        if matches!(
            endpoint_type,
            EndpointType::AudioTranscriptions | EndpointType::AudioTranslations
        ) && matched_files.is_empty()
        {
            result.status = RunStatus::Error;
            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
            result.error = Some(format!(
                "Endpoint {} requires an enabled [[endpoint_files]] entry.",
                endpoint_type.label()
            ));
            result.advice = Some(
                "Add [[endpoint_files]] pointing to a local audio file in benchforge.toml.".to_string(),
            );
            let _ = tx.send(EngineEvent::Update(result));
            return;
        }

        let mut loaded_files: Vec<(String, String, String, Vec<u8>)> = Vec::new();
        for f in &matched_files {
            match tokio::fs::read(&f.path).await {
                Ok(bytes) => {
                    let filename = std::path::Path::new(&f.path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("upload.bin")
                        .to_string();
                    let field = if f.field_name.trim().is_empty() {
                        "file".to_string()
                    } else {
                        f.field_name.trim().to_string()
                    };
                    let mime = if f.mime_type.trim().is_empty() {
                        "application/octet-stream".to_string()
                    } else {
                        f.mime_type.trim().to_string()
                    };
                    loaded_files.push((field, filename, mime, bytes));
                }
                Err(e) => {
                    result.status = RunStatus::Error;
                    result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                    result.error = Some(format!("Failed to read file '{}': {}", f.path, e));
                    result.advice = Some("Verify [[endpoint_files]].path exists on disk.".to_string());
                    let _ = tx.send(EngineEvent::Update(result));
                    return;
                }
            }
        }

        let boundary = format!("----benchforgeBoundary{}", dispatched_at.elapsed().as_nanos());
        if let Ok(val) = HeaderValue::from_str(&format!("multipart/form-data; boundary={}", boundary)) {
            headers.insert(CONTENT_TYPE, val);
        }
        let mut fields: Vec<(&str, &str)> = vec![("model", &target.model)];
        if !prompt.trim().is_empty() {
            fields.push(("prompt", prompt.trim()));
        }
        let file_refs: Vec<(&str, &str, &str, &[u8])> = loaded_files
            .iter()
            .map(|(fld, name, mime, data)| (fld.as_str(), name.as_str(), mime.as_str(), data.as_slice()))
            .collect();
        let multipart_bytes = build_multipart_body(&boundary, &fields, &file_refs);
        client.post(&url).headers(headers.clone()).body(multipart_bytes)
    } else {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let body = match endpoint_type {
            EndpointType::AudioSpeech => {
                let voice = if cfg.execution.tts_voice.trim().is_empty() {
                    "alloy"
                } else {
                    cfg.execution.tts_voice.trim()
                };
                serde_json::json!({
                    "model": target.model,
                    "input": effective_prompt,
                    "voice": voice,
                })
            }
            EndpointType::Embeddings => serde_json::json!({
                "model": target.model,
                "input": effective_prompt,
            }),
            EndpointType::Responses => {
                let mut payload = serde_json::json!({
                    "model": target.model,
                    "input": effective_prompt,
                    "stream": false,
                });
                if !disallow_sampling {
                    payload["temperature"] = serde_json::json!(cfg.execution.temperature);
                }
                if let Some(ref sys) = sys_prompt {
                    payload["instructions"] = serde_json::json!(sys);
                }
                if cfg.execution.max_tokens > 0 {
                    payload["max_output_tokens"] = serde_json::json!(cfg.execution.max_tokens);
                }
                payload
            }
            EndpointType::Custom => {
                let mut payload = serde_json::json!({
                    "model": target.model,
                    "input": effective_prompt,
                    "messages": messages,
                });
                if !disallow_sampling {
                    payload["temperature"] = serde_json::json!(cfg.execution.temperature);
                }
                payload
            }
            _ => {
                let mut payload = serde_json::json!({
                    "model": target.model,
                    "messages": messages,
                    "stream": cfg.execution.stream,
                });
                if !disallow_sampling {
                    payload["temperature"] = serde_json::json!(cfg.execution.temperature);
                    payload["top_p"] = serde_json::json!(cfg.execution.top_p);
                }
                if cfg.execution.max_tokens > 0 {
                    payload["max_tokens"] = serde_json::json!(cfg.execution.max_tokens);
                }
                if let Some(seed) = cfg.execution.seed {
                    payload["seed"] = serde_json::json!(seed);
                }
                if cfg.execution.stream {
                    payload["stream_options"] = serde_json::json!({ "include_usage": true });
                }
                payload
            }
        };
        json_body_opt = Some(body);
        client
            .post(&url)
            .headers(headers.clone())
            .json(json_body_opt.as_ref().expect("json payload"))
    };

    let resp_res = tokio::select! {
        r = tokio::time::timeout(timeout_dur, request_builder.send()) => {
            match r {
                Ok(inner) => inner,
                Err(_) => {
                    result.status = RunStatus::Error;
                    result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                    result.error = Some(format!("Request timed out after {}s", cfg.execution.timeout_sec));
                    result.advice = Some(build_advice(Some(504), "timed out", &provider.base_url));
                    let _ = tx.send(EngineEvent::Update(result));
                    return;
                }
            }
        }
        _ = abort_rx.changed() => {
            result.status = RunStatus::Aborted;
            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
            result.error = Some("Aborted by user".to_string());
            let _ = tx.send(EngineEvent::Update(result));
            return;
        }
    };

    let response = match resp_res {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            result.status = RunStatus::Error;
            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
            result.advice = Some(build_advice(None, &msg, &provider.base_url));
            result.error = Some(msg);
            let _ = tx.send(EngineEvent::Update(result));
            return;
        }
    };

    let mut headers_at = Instant::now();
    result.timing.request_ms = headers_at.duration_since(dispatched_at).as_secs_f64() * 1000.0;
    let mut status_code = response.status().as_u16();
    result.http_status = Some(status_code);

    let response = if !response.status().is_success() {
        let mut err_body = response.text().await.unwrap_or_default();
        let mut retry_ok: Option<reqwest::Response> = None;

        if status_code == 400 {
            if let Some(mut retry_json) = json_body_opt.take() {
                if strip_rejected_sampling_params(&mut retry_json, &err_body) {
                    let retry_res = tokio::select! {
                        r = tokio::time::timeout(
                            timeout_dur,
                            client.post(&url).headers(headers.clone()).json(&retry_json).send()
                        ) => {
                            match r {
                                Ok(inner) => inner,
                                Err(_) => {
                                    result.status = RunStatus::Error;
                                    result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                                    result.error = Some(format!("Request timed out after {}s", cfg.execution.timeout_sec));
                                    result.advice = Some(build_advice(Some(504), "timed out", &provider.base_url));
                                    let _ = tx.send(EngineEvent::Update(result));
                                    return;
                                }
                            }
                        }
                        _ = abort_rx.changed() => {
                            result.status = RunStatus::Aborted;
                            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                            result.error = Some("Aborted by user".to_string());
                            let _ = tx.send(EngineEvent::Update(result));
                            return;
                        }
                    };
                    match retry_res {
                        Ok(retry_resp) => {
                            headers_at = Instant::now();
                            result.timing.request_ms =
                                headers_at.duration_since(dispatched_at).as_secs_f64() * 1000.0;
                            status_code = retry_resp.status().as_u16();
                            result.http_status = Some(status_code);
                            if retry_resp.status().is_success() {
                                retry_ok = Some(retry_resp);
                            } else {
                                err_body = retry_resp.text().await.unwrap_or_default();
                            }
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            result.status = RunStatus::Error;
                            result.timing.total_ms =
                                dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                            result.advice = Some(build_advice(None, &msg, &provider.base_url));
                            result.error = Some(msg);
                            let _ = tx.send(EngineEvent::Update(result));
                            return;
                        }
                    }
                }
            }
        }

        if let Some(ok_resp) = retry_ok {
            ok_resp
        } else {
            result.status = RunStatus::Error;
            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
            result.error = Some(format!(
                "HTTP {} — {}",
                status_code,
                &err_body.chars().take(240).collect::<String>()
            ));
            result.advice = Some(build_advice(Some(status_code), &err_body, &provider.base_url));
            let _ = tx.send(EngineEvent::Update(result));
            return;
        }
    } else {
        response
    };

    let is_sse = endpoint_type == EndpointType::ChatCompletions
        && cfg.execution.stream
        && response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.contains("text/event-stream"))
            .unwrap_or(false);

    if is_sse {
        let mut stream = response.bytes_stream();
        let mut sse_buf = String::new();
        let mut first_token_at: Option<Instant> = None;

        while let Some(chunk_res) = tokio::select! {
            c = stream.next() => c,
            _ = abort_rx.changed() => {
                result.status = RunStatus::Aborted;
                result.error = Some("Stream aborted by user".to_string());
                result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                let _ = tx.send(EngineEvent::Update(result));
                return;
            }
        } {
            let Ok(bytes) = chunk_res else {
                break;
            };
            sse_buf.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(pos) = sse_buf.find('\n') {
                let line = sse_buf[..pos].trim().to_string();
                sse_buf.drain(..=pos);

                if !line.starts_with("data:") {
                    continue;
                }
                let payload_str = line[5..].trim();
                if payload_str == "[DONE]" {
                    break;
                }
                if let Ok(parsed) = serde_json::from_str::<SsePayload>(payload_str) {
                    if let Some(err_val) = parsed.error {
                        result.status = RunStatus::Error;
                        result.error = Some(err_val.to_string());
                        result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                        let _ = tx.send(EngineEvent::Update(result));
                        return;
                    }
                    if let Some(u) = parsed.usage {
                        if let Some(pt) = u.prompt_tokens {
                            result.prompt_tokens = pt;
                        }
                        if let Some(ct) = u.completion_tokens {
                            result.completion_tokens = ct;
                        }
                        if let Some(tt) = u.total_tokens {
                            result.total_tokens = tt;
                        }
                    }
                    if let Some(choices) = parsed.choices {
                        if let Some(c0) = choices.first() {
                            let delta = c0
                                .delta
                                .as_ref()
                                .and_then(|d| d.content.as_deref().or(d.reasoning_content.as_deref()))
                                .or_else(|| c0.message.as_ref().and_then(|m| m.content.as_deref()))
                                .unwrap_or("");
                            if !delta.is_empty() {
                                let now = Instant::now();
                                if first_token_at.is_none() {
                                    first_token_at = Some(now);
                                    result.timing.ttfb_ms = Some(
                                        now.duration_since(dispatched_at).as_secs_f64() * 1000.0,
                                    );
                                }
                                result.status = RunStatus::Streaming;
                                result.output.push_str(delta);
                                let est = estimate_tokens(&result.output);
                                if result.completion_tokens == 0 {
                                    result.completion_tokens = est;
                                }
                                result.total_tokens = result.prompt_tokens + result.completion_tokens;
                                let dl_ms = first_token_at
                                    .map(|ft| now.duration_since(ft).as_secs_f64() * 1000.0)
                                    .unwrap_or(0.0);
                                result.timing.download_ms = dl_ms;
                                result.timing.total_ms =
                                    now.duration_since(dispatched_at).as_secs_f64() * 1000.0 + queue_ms;
                                if dl_ms > 10.0 {
                                    result.tokens_per_sec =
                                        ((result.completion_tokens as f64 / dl_ms) * 1000.0 * 10.0)
                                            .round()
                                            / 10.0;
                                }
                                let _ = tx.send(EngineEvent::Update(result.clone()));
                            }
                        }
                    }
                }
            }
        }

        let end = Instant::now();
        result.status = RunStatus::Completed;
        if result.completion_tokens == 0 {
            result.completion_tokens = estimate_tokens(&result.output);
        }
        result.total_tokens = result.prompt_tokens + result.completion_tokens;
        let dl_ms = first_token_at
            .map(|ft| end.duration_since(ft).as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        result.timing.download_ms = dl_ms;
        result.timing.total_ms = end.duration_since(dispatched_at).as_secs_f64() * 1000.0 + queue_ms;
        let denom_ms = if dl_ms > 10.0 { dl_ms } else { result.timing.total_ms - queue_ms };
        if denom_ms > 0.0 && result.completion_tokens > 0 {
            result.tokens_per_sec =
                ((result.completion_tokens as f64 / denom_ms) * 1000.0 * 10.0).round() / 10.0;
        }
        let _ = tx.send(EngineEvent::Update(result));
    } else if endpoint_type == EndpointType::AudioSpeech {
        let resp_mime = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("audio/mpeg")
            .to_string();
        let bytes_res = response.bytes().await;
        let end = Instant::now();
        result.timing.ttfb_ms = Some(headers_at.duration_since(dispatched_at).as_secs_f64() * 1000.0);
        result.timing.download_ms = end.duration_since(headers_at).as_secs_f64() * 1000.0;
        result.timing.total_ms = end.duration_since(dispatched_at).as_secs_f64() * 1000.0 + queue_ms;
        match bytes_res {
            Ok(bytes) => {
                let _ = tokio::fs::create_dir_all("exports").await;
                let safe_id: String = target
                    .id
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect();
                let out_path = format!("exports/{}-speech.mp3", safe_id);
                let saved_note = match tokio::fs::write(&out_path, &bytes).await {
                    Ok(_) => format!(" -> saved {}", out_path),
                    Err(_) => String::new(),
                };
                result.output = format!(
                    "[Audio Speech Generated: {}, {} bytes{}]",
                    resp_mime,
                    bytes.len(),
                    saved_note
                );
                result.status = RunStatus::Completed;
            }
            Err(e) => {
                result.status = RunStatus::Error;
                result.error = Some(format!("Failed reading binary audio response: {}", e));
            }
        }
        let _ = tx.send(EngineEvent::Update(result));
    } else {
        let raw_text_res = response.text().await;
        let end = Instant::now();
        result.timing.ttfb_ms = Some(headers_at.duration_since(dispatched_at).as_secs_f64() * 1000.0);
        result.timing.download_ms = end.duration_since(headers_at).as_secs_f64() * 1000.0;
        result.timing.total_ms = end.duration_since(dispatched_at).as_secs_f64() * 1000.0 + queue_ms;
        match raw_text_res {
            Ok(raw_text) => {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw_text) {
                    if let Some(chat_text) = val
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c0| c0.get("message"))
                        .and_then(|m| m.get("content"))
                        .and_then(|s| s.as_str())
                    {
                        result.output = chat_text.to_string();
                    } else if let Some(resp_text) = val.get("output_text").and_then(|s| s.as_str()) {
                        result.output = resp_text.to_string();
                    } else if let Some(tr_text) = val.get("text").and_then(|s| s.as_str()) {
                        result.output = tr_text.to_string();
                    } else if let Some(emb) = val
                        .get("data")
                        .and_then(|d| d.get(0))
                        .and_then(|d0| d0.get("embedding"))
                        .and_then(|e| e.as_array())
                    {
                        let preview: Vec<String> = emb
                            .iter()
                            .take(8)
                            .filter_map(|n| n.as_f64().map(|f| format!("{:.5}", f)))
                            .collect();
                        result.output = format!(
                            "Embedding dimensions: {}\nPreview[0..8]: [{}]",
                            emb.len(),
                            preview.join(", ")
                        );
                    } else {
                        result.output =
                            serde_json::to_string_pretty(&val).unwrap_or(raw_text);
                    }

                    if let Some(u) = val.get("usage") {
                        if let Some(pt) = u.get("prompt_tokens").and_then(|n| n.as_u64()) {
                            result.prompt_tokens = pt;
                        }
                        if let Some(ct) = u.get("completion_tokens").and_then(|n| n.as_u64()) {
                            result.completion_tokens = ct;
                        } else {
                            result.completion_tokens = estimate_tokens(&result.output);
                        }
                        result.total_tokens = u
                            .get("total_tokens")
                            .and_then(|n| n.as_u64())
                            .unwrap_or(result.prompt_tokens + result.completion_tokens);
                    } else {
                        result.completion_tokens = estimate_tokens(&result.output);
                        result.total_tokens = result.prompt_tokens + result.completion_tokens;
                    }
                    let gen_ms = (result.timing.total_ms - queue_ms).max(1.0);
                    result.tokens_per_sec =
                        ((result.completion_tokens as f64 / gen_ms) * 1000.0 * 10.0).round() / 10.0;
                    result.status = RunStatus::Completed;
                } else {
                    result.output = raw_text;
                    result.completion_tokens = estimate_tokens(&result.output);
                    result.total_tokens = result.prompt_tokens + result.completion_tokens;
                    result.status = RunStatus::Completed;
                }
            }
            Err(e) => {
                result.status = RunStatus::Error;
                result.error = Some(format!("Failed reading endpoint response: {}", e));
            }
        }
        let _ = tx.send(EngineEvent::Update(result));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_reasoning_models_and_strips_rejected_temperature_on_400() {
        assert!(model_disallows_sampling_params("o3-mini"));
        assert!(model_disallows_sampling_params("openai/o1"));
        assert!(model_disallows_sampling_params("gpt-5-mini"));
        assert!(model_disallows_sampling_params("deepseek-reasoner"));
        assert!(!model_disallows_sampling_params("gpt-4o-mini"));

        let mut payload = serde_json::json!({
            "model": "some-custom-model",
            "temperature": 0.7,
            "top_p": 1.0,
            "max_tokens": 512,
        });
        assert!(strip_rejected_sampling_params(
            &mut payload,
            "Unsupported parameter: 'temperature' is not supported with this model."
        ));
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("top_p").is_none());
        assert!(payload.get("max_tokens").is_some());
    }
}

use crate::config::{
    BenchConfig, CustomSendParam, EndpointType, ExecutionMode, ProviderConfig, SystemTargetMode,
    TargetConfig,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatTurnMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub enum EngineEvent {
    Update(ModelRunResult),
    BatchFinished,
    ChatUpdate(ModelRunResult),
    ChatFinished,
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

pub fn spawn_chat_turn(
    cfg: BenchConfig,
    target: TargetConfig,
    history_messages: Vec<ChatTurnMessage>,
    tx: mpsc::UnboundedSender<EngineEvent>,
    abort_rx: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let batch_start = Instant::now();
        let prompt = history_messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();

        if let Some(provider) = cfg.find_provider(&target.provider_id).cloned() {
            let mut target_abort = abort_rx;
            run_single_target_inner(
                client,
                batch_start,
                &cfg,
                &target,
                &provider,
                &prompt,
                Some(&history_messages),
                true,
                &tx,
                &mut target_abort,
            )
            .await;
        } else {
            let _ = tx.send(EngineEvent::ChatUpdate(ModelRunResult {
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
                error: Some("Provider not found for selected chat target".to_string()),
                advice: Some("Select a valid target/provider in 7:Chat Send Config or 6:Config.".to_string()),
            }));
        }
        let _ = tx.send(EngineEvent::ChatFinished);
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

pub fn parse_custom_param_value(raw: &str) -> serde_json::Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return serde_json::Value::String(String::new());
    }
    if trimmed == "true" {
        return serde_json::Value::Bool(true);
    }
    if trimmed == "false" {
        return serde_json::Value::Bool(false);
    }
    if trimmed == "null" {
        return serde_json::Value::Null;
    }
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return parsed;
        }
    }
    if let Ok(int_val) = trimmed.parse::<i64>() {
        return serde_json::json!(int_val);
    }
    if let Ok(float_val) = trimmed.parse::<f64>() {
        if float_val.is_finite() {
            return serde_json::json!(float_val);
        }
    }
    serde_json::Value::String(raw.to_string())
}

pub fn apply_extra_params(payload: &mut serde_json::Value, extras: &[CustomSendParam]) {
    let Some(obj) = payload.as_object_mut() else {
        return;
    };
    for p in extras {
        if !p.enabled {
            continue;
        }
        let key = p.key.trim();
        if key.is_empty() {
            continue;
        }
        obj.insert(key.to_string(), parse_custom_param_value(&p.value));
    }
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
    run_single_target_inner(
        client,
        batch_start,
        cfg,
        target,
        provider,
        prompt,
        None,
        false,
        tx,
        abort_rx,
    )
    .await;
}

pub fn build_chat_messages(
    sys_prompt: Option<&str>,
    effective_prompt: &str,
    history_messages: Option<&[ChatTurnMessage]>,
) -> (Vec<serde_json::Value>, u64) {
    let mut messages = Vec::new();
    let mut est_prompt_tokens = 0u64;

    if let Some(hist) = history_messages {
        let filtered: Vec<&ChatTurnMessage> = hist
            .iter()
            .filter(|m| {
                let role_lower = m.role.trim().to_ascii_lowercase();
                let trimmed = m.content.trim();
                if role_lower == "assistant"
                    && (trimmed.is_empty()
                        || trimmed == "..."
                        || trimmed.starts_with("ERROR:"))
                {
                    return false;
                }
                true
            })
            .collect();

        if let Some(sys) = sys_prompt {
            let already_has_sys = filtered
                .first()
                .map(|m| m.role.trim().eq_ignore_ascii_case("system"))
                .unwrap_or(false);
            if !already_has_sys {
                est_prompt_tokens += estimate_tokens(sys);
                messages.push(serde_json::json!({ "role": "system", "content": sys }));
            }
        }

        let last_user_pos = filtered
            .iter()
            .rposition(|m| m.role.trim().eq_ignore_ascii_case("user"));
        for (idx, m) in filtered.iter().enumerate() {
            let role = m.role.trim().to_ascii_lowercase();
            let content = if Some(idx) == last_user_pos && !effective_prompt.is_empty() {
                effective_prompt
            } else {
                m.content.as_str()
            };
            if content.trim().is_empty() {
                continue;
            }
            est_prompt_tokens += estimate_tokens(content);
            messages.push(serde_json::json!({ "role": role, "content": content }));
        }

        if last_user_pos.is_none() && !effective_prompt.trim().is_empty() {
            est_prompt_tokens += estimate_tokens(effective_prompt);
            messages.push(serde_json::json!({ "role": "user", "content": effective_prompt }));
        }
    } else {
        if let Some(sys) = sys_prompt {
            est_prompt_tokens += estimate_tokens(sys);
            messages.push(serde_json::json!({ "role": "system", "content": sys }));
        }
        est_prompt_tokens += estimate_tokens(effective_prompt);
        messages.push(serde_json::json!({ "role": "user", "content": effective_prompt }));
    }

    (messages, est_prompt_tokens)
}

pub fn build_endpoint_payload(
    cfg: &BenchConfig,
    target: &TargetConfig,
    sys_prompt: Option<&str>,
    effective_prompt: &str,
    messages: &[serde_json::Value],
    has_history: bool,
    use_stream: bool,
    disallow_sampling: bool,
) -> serde_json::Value {
    let endpoint_type = cfg.execution.endpoint_type;
    let act = &cfg.execution.active_params;

    let mut body = match endpoint_type {
        EndpointType::AudioSpeech => {
            let mut payload = serde_json::json!({
                "model": target.model,
                "input": effective_prompt,
            });
            if act.tts_voice {
                let voice = if cfg.execution.tts_voice.trim().is_empty() {
                    "alloy"
                } else {
                    cfg.execution.tts_voice.trim()
                };
                payload["voice"] = serde_json::json!(voice);
            }
            payload
        }
        EndpointType::Embeddings => serde_json::json!({
            "model": target.model,
            "input": effective_prompt,
        }),
        EndpointType::Responses => {
            let non_sys_items: Vec<serde_json::Value> = messages
                .iter()
                .filter(|m| m.get("role").and_then(|r| r.as_str()) != Some("system"))
                .cloned()
                .collect();
            let input_value = if (has_history || non_sys_items.len() > 1) && !non_sys_items.is_empty() {
                serde_json::Value::Array(non_sys_items)
            } else {
                serde_json::json!(effective_prompt)
            };
            let mut payload = serde_json::json!({
                "model": target.model,
                "input": input_value,
                "stream": false,
            });
            if !disallow_sampling && act.temperature {
                payload["temperature"] = serde_json::json!(cfg.execution.temperature);
            }
            if let Some(sys) = sys_prompt {
                payload["instructions"] = serde_json::json!(sys);
            } else if let Some(sys_content) = messages
                .iter()
                .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("system"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
            {
                payload["instructions"] = serde_json::json!(sys_content);
            }
            if act.max_tokens && cfg.execution.max_tokens > 0 {
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
            if !disallow_sampling && act.temperature {
                payload["temperature"] = serde_json::json!(cfg.execution.temperature);
            }
            payload
        }
        _ => {
            let mut payload = serde_json::json!({
                "model": target.model,
                "messages": messages,
                "stream": use_stream,
            });
            if !disallow_sampling {
                if act.temperature {
                    payload["temperature"] = serde_json::json!(cfg.execution.temperature);
                }
                if act.top_p {
                    payload["top_p"] = serde_json::json!(cfg.execution.top_p);
                }
            }
            if act.max_tokens && cfg.execution.max_tokens > 0 {
                payload["max_tokens"] = serde_json::json!(cfg.execution.max_tokens);
            }
            if act.seed {
                if let Some(seed) = cfg.execution.seed {
                    payload["seed"] = serde_json::json!(seed);
                }
            }
            if use_stream {
                payload["stream_options"] = serde_json::json!({ "include_usage": true });
            }
            payload
        }
    };
    apply_extra_params(&mut body, &cfg.execution.extra_params);
    body
}

#[allow(clippy::too_many_arguments)]
async fn run_single_target_inner(
    client: reqwest::Client,
    batch_start: Instant,
    cfg: &BenchConfig,
    target: &TargetConfig,
    provider: &ProviderConfig,
    prompt: &str,
    history_messages: Option<&[ChatTurnMessage]>,
    chat_mode: bool,
    tx: &mpsc::UnboundedSender<EngineEvent>,
    abort_rx: &mut watch::Receiver<bool>,
) {
    let emit = |res: ModelRunResult| {
        let ev = if chat_mode {
            EngineEvent::ChatUpdate(res)
        } else {
            EngineEvent::Update(res)
        };
        let _ = tx.send(ev);
    };

    let dispatched_at = Instant::now();
    let queue_ms = dispatched_at.duration_since(batch_start).as_secs_f64() * 1000.0;
    let sys_prompt = resolve_system_prompt(target, cfg);
    let endpoint_type = cfg.execution.endpoint_type;
    let act = &cfg.execution.active_params;
    let use_stream = cfg.execution.stream && act.stream;
    let matched_files = if act.endpoint_files {
        cfg.matching_endpoint_files()
    } else {
        Vec::new()
    };

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

    let (messages, est_prompt_tokens) =
        build_chat_messages(sys_prompt.as_deref(), &effective_prompt, history_messages);

    let mut headers = HeaderMap::new();
    if let Some(key) = provider.resolve_api_key() {
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", key)) {
            headers.insert(AUTHORIZATION, val);
        }
    }
    if act.custom_headers {
        for (k, v) in &provider.custom_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
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
    emit(result.clone());

    let custom_endpoint_val = if act.custom_endpoint {
        cfg.execution.custom_endpoint.as_str()
    } else {
        ""
    };
    let url = resolve_endpoint_url(&provider.base_url, endpoint_type, custom_endpoint_val);
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
            emit(result);
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
                    emit(result);
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
        let body = build_endpoint_payload(
            cfg,
            target,
            sys_prompt.as_deref(),
            &effective_prompt,
            &messages,
            chat_mode || history_messages.is_some(),
            use_stream,
            disallow_sampling,
        );
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
                    emit(result);
                    return;
                }
            }
        }
        _ = abort_rx.changed() => {
            result.status = RunStatus::Aborted;
            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
            result.error = Some("Aborted by user".to_string());
            emit(result);
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
            emit(result);
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
                                    emit(result);
                                    return;
                                }
                            }
                        }
                        _ = abort_rx.changed() => {
                            result.status = RunStatus::Aborted;
                            result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
                            result.error = Some("Aborted by user".to_string());
                            emit(result);
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
                            emit(result);
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
            emit(result);
            return;
        }
    } else {
        response
    };

    let is_sse = endpoint_type == EndpointType::ChatCompletions
        && use_stream
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
                emit(result);
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
                        emit(result);
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
                                emit(result.clone());
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
        emit(result);
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
        emit(result);
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
                    } else if let Some(resp_items) = val.get("output").and_then(|o| o.as_array()) {
                        let mut parts = Vec::new();
                        for item in resp_items {
                            if let Some(content_arr) = item.get("content").and_then(|c| c.as_array()) {
                                for c_item in content_arr {
                                    if let Some(t) = c_item.get("text").and_then(|s| s.as_str()) {
                                        if !t.is_empty() {
                                            parts.push(t.to_string());
                                        }
                                    }
                                }
                            } else if let Some(t) = item.get("text").and_then(|s| s.as_str()) {
                                if !t.is_empty() {
                                    parts.push(t.to_string());
                                }
                            }
                        }
                        if parts.is_empty() {
                            result.output =
                                serde_json::to_string_pretty(&val).unwrap_or(raw_text);
                        } else {
                            result.output = parts.join("\n");
                        }
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
                        if let Some(pt) = u
                            .get("prompt_tokens")
                            .or_else(|| u.get("input_tokens"))
                            .and_then(|n| n.as_u64())
                        {
                            result.prompt_tokens = pt;
                        }
                        if let Some(ct) = u
                            .get("completion_tokens")
                            .or_else(|| u.get("output_tokens"))
                            .and_then(|n| n.as_u64())
                        {
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
        emit(result);
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

    #[test]
    fn applies_extra_params_and_parses_typed_json_values() {
        let mut payload = serde_json::json!({
            "model": "gpt-4o-mini",
            "stream": false
        });
        let extras = vec![
            CustomSendParam {
                key: "presence_penalty".to_string(),
                value: "0.25".to_string(),
                enabled: true,
            },
            CustomSendParam {
                key: "stop".to_string(),
                value: "[\"END\"]".to_string(),
                enabled: true,
            },
            CustomSendParam {
                key: "disabled_flag".to_string(),
                value: "true".to_string(),
                enabled: false,
            },
        ];
        apply_extra_params(&mut payload, &extras);
        assert_eq!(payload["presence_penalty"], serde_json::json!(0.25));
        assert_eq!(payload["stop"], serde_json::json!(["END"]));
        assert!(payload.get("disabled_flag").is_none());
    }

    #[test]
    fn builds_full_multi_turn_history_for_chat_and_responses_endpoints() {
        let mut cfg = BenchConfig::default();
        let target = cfg.targets[0].clone();
        let history = vec![
            ChatTurnMessage {
                role: "user".to_string(),
                content: "First question".to_string(),
            },
            ChatTurnMessage {
                role: "assistant".to_string(),
                content: "First answer".to_string(),
            },
            ChatTurnMessage {
                role: "assistant".to_string(),
                content: "ERROR: transient failure".to_string(),
            },
            ChatTurnMessage {
                role: "user".to_string(),
                content: "Follow up question".to_string(),
            },
        ];

        let (messages, _) = build_chat_messages(
            Some("Be concise"),
            "Follow up question",
            Some(&history),
        );
        // System + user1 + assistant1 + user2 (error turn skipped)
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1], serde_json::json!({"role": "user", "content": "First question"}));
        assert_eq!(messages[2], serde_json::json!({"role": "assistant", "content": "First answer"}));
        assert_eq!(messages[3], serde_json::json!({"role": "user", "content": "Follow up question"}));

        cfg.execution.endpoint_type = EndpointType::ChatCompletions;
        let chat_payload = build_endpoint_payload(
            &cfg,
            &target,
            Some("Be concise"),
            "Follow up question",
            &messages,
            true,
            false,
            false,
        );
        assert_eq!(chat_payload["messages"].as_array().unwrap().len(), 4);

        cfg.execution.endpoint_type = EndpointType::Responses;
        let resp_payload = build_endpoint_payload(
            &cfg,
            &target,
            Some("Be concise"),
            "Follow up question",
            &messages,
            true,
            false,
            false,
        );
        assert_eq!(resp_payload["instructions"], "Be concise");
        let input_arr = resp_payload["input"].as_array().expect("responses input history array");
        assert_eq!(input_arr.len(), 3);
        assert_eq!(input_arr[0], serde_json::json!({"role": "user", "content": "First question"}));
        assert_eq!(input_arr[1], serde_json::json!({"role": "assistant", "content": "First answer"}));
        assert_eq!(input_arr[2], serde_json::json!({"role": "user", "content": "Follow up question"}));
    }
}

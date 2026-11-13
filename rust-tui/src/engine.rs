use crate::config::{
    BenchConfig, ExecutionMode, ProviderConfig, SystemTargetMode, TargetConfig,
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

#[derive(Debug, Clone)]
pub enum EngineEvent {
    Update(ModelRunResult),
    BatchFinished,
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
        Some(401 | 403) => "Verify api_key_env or custom_headers Authorization token.".to_string(),
        Some(404) => format!("Verify base_url ({}) includes /v1 and model ID exists.", base_url),
        Some(429) => "Rate limited (429). Lower execution.concurrency or retry.".to_string(),
        _ => "Inspect provider base_url, model name, and network connectivity.".to_string(),
    }
}

pub fn spawn_benchmark_batch(
    cfg: BenchConfig,
    targets: Vec<TargetConfig>,
    prompt: String,
    tx: mpsc::UnboundedSender<EngineEvent>,
    mut abort_rx: watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        let concurrency = match cfg.execution.mode {
            ExecutionMode::Sequential => 1,
            ExecutionMode::Parallel => cfg.execution.concurrency.clamp(1, 10),
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

    let mut messages = Vec::new();
    let mut est_prompt_tokens = estimate_tokens(prompt);
    if let Some(ref sys) = sys_prompt {
        est_prompt_tokens += estimate_tokens(sys);
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));

    let mut body = serde_json::json!({
        "model": target.model,
        "messages": messages,
        "stream": cfg.execution.stream,
        "temperature": cfg.execution.temperature,
        "top_p": cfg.execution.top_p,
    });
    if cfg.execution.max_tokens > 0 {
        body["max_tokens"] = serde_json::json!(cfg.execution.max_tokens);
    }
    if let Some(seed) = cfg.execution.seed {
        body["seed"] = serde_json::json!(seed);
    }
    if cfg.execution.stream {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }

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

    let url = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));
    let timeout_dur = Duration::from_secs(cfg.execution.timeout_sec.clamp(5, 600));

    let resp_res = tokio::select! {
        r = tokio::time::timeout(timeout_dur, client.post(&url).headers(headers).json(&body).send()) => {
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

    let headers_at = Instant::now();
    result.timing.request_ms = headers_at.duration_since(dispatched_at).as_secs_f64() * 1000.0;
    let status_code = response.status().as_u16();
    result.http_status = Some(status_code);

    if !response.status().is_success() {
        let err_body = response.text().await.unwrap_or_default();
        result.status = RunStatus::Error;
        result.timing.total_ms = dispatched_at.elapsed().as_secs_f64() * 1000.0 + queue_ms;
        result.error = Some(format!("HTTP {} — {}", status_code, &err_body.chars().take(240).collect::<String>()));
        result.advice = Some(build_advice(Some(status_code), &err_body, &provider.base_url));
        let _ = tx.send(EngineEvent::Update(result));
        return;
    }

    let is_sse = cfg.execution.stream
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
    } else {
        let json_res = response.json::<SsePayload>().await;
        let end = Instant::now();
        result.timing.ttfb_ms = Some(headers_at.duration_since(dispatched_at).as_secs_f64() * 1000.0);
        result.timing.download_ms = end.duration_since(headers_at).as_secs_f64() * 1000.0;
        result.timing.total_ms = end.duration_since(dispatched_at).as_secs_f64() * 1000.0 + queue_ms;
        if let Ok(parsed) = json_res {
            let text = parsed
                .choices
                .and_then(|c| c.into_iter().next())
                .and_then(|c| c.message)
                .and_then(|m| m.content)
                .unwrap_or_default();
            result.output = text;
            if let Some(u) = parsed.usage {
                result.prompt_tokens = u.prompt_tokens.unwrap_or(est_prompt_tokens);
                result.completion_tokens =
                    u.completion_tokens.unwrap_or_else(|| estimate_tokens(&result.output));
                result.total_tokens =
                    u.total_tokens.unwrap_or(result.prompt_tokens + result.completion_tokens);
            } else {
                result.completion_tokens = estimate_tokens(&result.output);
                result.total_tokens = result.prompt_tokens + result.completion_tokens;
            }
            let gen_ms = (result.timing.total_ms - queue_ms).max(1.0);
            result.tokens_per_sec =
                ((result.completion_tokens as f64 / gen_ms) * 1000.0 * 10.0).round() / 10.0;
            result.status = RunStatus::Completed;
        } else {
            result.status = RunStatus::Error;
            result.error = Some("Invalid JSON response from /chat/completions".to_string());
        }
        let _ = tx.send(EngineEvent::Update(result));
    }
}

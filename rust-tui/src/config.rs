use anyhow::{bail, Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    Light,
    Dark,
    SepiaLight,
    SepiaDark,
    GreenishSepia,
}

impl ThemeId {
    pub fn next(self) -> Self {
        match self {
            ThemeId::Dark => ThemeId::Light,
            ThemeId::Light => ThemeId::SepiaLight,
            ThemeId::SepiaLight => ThemeId::SepiaDark,
            ThemeId::SepiaDark => ThemeId::GreenishSepia,
            ThemeId::GreenishSepia => ThemeId::Dark,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ThemeId::Light => "Light",
            ThemeId::Dark => "Dark",
            ThemeId::SepiaLight => "Sepia Light",
            ThemeId::SepiaDark => "Sepia Dark",
            ThemeId::GreenishSepia => "Greenish Sepia",
        }
    }

    pub fn from_str_lossy(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "light" => Some(ThemeId::Light),
            "dark" => Some(ThemeId::Dark),
            "sepia-light" | "sepia_light" => Some(ThemeId::SepiaLight),
            "sepia-dark" | "sepia_dark" => Some(ThemeId::SepiaDark),
            "greenish-sepia" | "greenish_sepia" => Some(ThemeId::GreenishSepia),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Parallel,
    Sequential,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndpointType {
    ChatCompletions,
    AudioTranscriptions,
    AudioTranslations,
    AudioSpeech,
    Embeddings,
    Responses,
    Custom,
}

impl Default for EndpointType {
    fn default() -> Self {
        EndpointType::ChatCompletions
    }
}

impl EndpointType {
    pub fn next(self) -> Self {
        match self {
            EndpointType::ChatCompletions => EndpointType::AudioTranscriptions,
            EndpointType::AudioTranscriptions => EndpointType::AudioTranslations,
            EndpointType::AudioTranslations => EndpointType::AudioSpeech,
            EndpointType::AudioSpeech => EndpointType::Embeddings,
            EndpointType::Embeddings => EndpointType::Responses,
            EndpointType::Responses => EndpointType::Custom,
            EndpointType::Custom => EndpointType::ChatCompletions,
        }
    }

    pub fn as_id(self) -> &'static str {
        match self {
            EndpointType::ChatCompletions => "chat-completions",
            EndpointType::AudioTranscriptions => "audio-transcriptions",
            EndpointType::AudioTranslations => "audio-translations",
            EndpointType::AudioSpeech => "audio-speech",
            EndpointType::Embeddings => "embeddings",
            EndpointType::Responses => "responses",
            EndpointType::Custom => "custom",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            EndpointType::ChatCompletions => "/v1/chat/completions",
            EndpointType::AudioTranscriptions => "/v1/audio/transcriptions",
            EndpointType::AudioTranslations => "/v1/audio/translations",
            EndpointType::AudioSpeech => "/v1/audio/speech",
            EndpointType::Embeddings => "/v1/embeddings",
            EndpointType::Responses => "/v1/responses",
            EndpointType::Custom => "Custom Endpoint",
        }
    }

    pub fn suffix(self) -> &'static str {
        match self {
            EndpointType::ChatCompletions => "/chat/completions",
            EndpointType::AudioTranscriptions => "/audio/transcriptions",
            EndpointType::AudioTranslations => "/audio/translations",
            EndpointType::AudioSpeech => "/audio/speech",
            EndpointType::Embeddings => "/embeddings",
            EndpointType::Responses => "/responses",
            EndpointType::Custom => "",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExecutionConfig {
    pub mode: ExecutionMode,
    pub concurrency: usize,
    pub timeout_sec: u64,
    pub stream: bool,
    pub randomize_order: bool,
    pub temperature: f32,
    pub max_tokens: u32,
    pub top_p: f32,
    pub seed: Option<u64>,
    pub endpoint_type: EndpointType,
    pub custom_endpoint: String,
    pub tts_voice: String,
}

impl Default for ExecutionConfig {
    fn default() -> Self {
        Self {
            mode: ExecutionMode::Parallel,
            concurrency: 3,
            timeout_sec: 300,
            stream: true,
            randomize_order: false,
            temperature: 0.7,
            max_tokens: 2048,
            top_p: 1.0,
            seed: None,
            endpoint_type: EndpointType::ChatCompletions,
            custom_endpoint: String::new(),
            tts_voice: "alloy".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemTargetMode {
    All,
    Specific,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SystemPromptConfig {
    pub enabled: bool,
    pub persona: Option<String>,
    pub target_mode: SystemTargetMode,
    pub target_models: Vec<String>,
    pub content: String,
}

impl Default for SystemPromptConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            persona: None,
            target_mode: SystemTargetMode::All,
            target_models: Vec::new(),
            content: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    pub theme: ThemeId,
    pub history_limit: usize,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            theme: ThemeId::Dark,
            history_limit: 50,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key_env: String,
    #[serde(default)]
    pub anon_key: String,
    pub table_name: String,
    pub auto_sync: bool,
}

impl Default for SupabaseConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            anon_key_env: "SUPABASE_ANON_KEY".to_string(),
            anon_key: String::new(),
            table_name: "benchmark_runs".to_string(),
            auto_sync: false,
        }
    }
}

impl SupabaseConfig {
    pub fn resolve_key(&self) -> Option<String> {
        if !self.anon_key.trim().is_empty() {
            return Some(self.anon_key.clone());
        }
        if !self.anon_key_env.trim().is_empty() {
            if let Ok(val) = env::var(&self.anon_key_env) {
                if !val.trim().is_empty() {
                    return Some(val);
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub api_key_env: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
    #[serde(default)]
    pub models: Vec<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            id: "custom".to_string(),
            name: "Custom OpenAI".to_string(),
            kind: "custom".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            api_key_env: String::new(),
            api_key: String::new(),
            custom_headers: HashMap::new(),
            models: Vec::new(),
        }
    }
}

impl ProviderConfig {
    /// Resolves Bearer token safely from inline `api_key` or environment variable `api_key_env`.
    pub fn resolve_api_key(&self) -> Option<String> {
        if !self.api_key.trim().is_empty() {
            return Some(self.api_key.trim().to_string());
        }
        if !self.api_key_env.trim().is_empty() {
            if let Ok(val) = env::var(self.api_key_env.trim()) {
                if !val.trim().is_empty() {
                    return Some(val.trim().to_string());
                }
            }
        }
        None
    }

    pub fn key_status_label(&self) -> String {
        if !self.api_key.trim().is_empty() {
            "inline key set".to_string()
        } else if !self.api_key_env.trim().is_empty() {
            match env::var(self.api_key_env.trim()) {
                Ok(v) if !v.trim().is_empty() => format!("env:{} (set)", self.api_key_env),
                _ => format!("env:{} (unset)", self.api_key_env),
            }
        } else {
            "no auth".to_string()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TargetConfig {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub enabled: bool,
    pub system_prompt_override: Option<String>,
}

impl Default for TargetConfig {
    fn default() -> Self {
        Self {
            id: "target-default".to_string(),
            provider_id: "ollama-local".to_string(),
            model: "llama3.2:latest".to_string(),
            enabled: true,
            system_prompt_override: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SubgroupConfig {
    pub id: String,
    pub name: String,
    pub filter: String,
    pub target_ids: Vec<String>,
}

impl Default for SubgroupConfig {
    fn default() -> Self {
        Self {
            id: "subgroup-default".to_string(),
            name: "Default Subgroup".to_string(),
            filter: String::new(),
            target_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct EndpointFileConfig {
    pub id: String,
    pub path: String,
    pub mime_type: String,
    pub endpoint_type: String,
    pub field_name: String,
    pub enabled: bool,
}

impl Default for EndpointFileConfig {
    fn default() -> Self {
        Self {
            id: "file-default".to_string(),
            path: String::new(),
            mime_type: "application/octet-stream".to_string(),
            endpoint_type: "all".to_string(),
            field_name: "file".to_string(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BenchConfig {
    pub execution: ExecutionConfig,
    pub system_prompt: SystemPromptConfig,
    pub ui: UiConfig,
    pub supabase: SupabaseConfig,
    pub providers: Vec<ProviderConfig>,
    pub targets: Vec<TargetConfig>,
    pub subgroups: Vec<SubgroupConfig>,
    pub endpoint_files: Vec<EndpointFileConfig>,
}

impl Default for BenchConfig {
    fn default() -> Self {
        Self {
            execution: ExecutionConfig::default(),
            system_prompt: SystemPromptConfig::default(),
            ui: UiConfig::default(),
            supabase: SupabaseConfig::default(),
            providers: vec![
                ProviderConfig {
                    id: "ollama-local".to_string(),
                    name: "Ollama Local".to_string(),
                    kind: "ollama".to_string(),
                    base_url: "http://localhost:11434/v1".to_string(),
                    api_key_env: String::new(),
                    api_key: String::new(),
                    custom_headers: HashMap::new(),
                    models: vec!["llama3.2:latest".to_string(), "qwen2.5-coder:7b".to_string()],
                },
                ProviderConfig {
                    id: "lmstudio-local".to_string(),
                    name: "LM Studio".to_string(),
                    kind: "lmstudio".to_string(),
                    base_url: "http://localhost:1234/v1".to_string(),
                    api_key_env: String::new(),
                    api_key: String::new(),
                    custom_headers: HashMap::new(),
                    models: vec!["local-model".to_string()],
                },
                ProviderConfig {
                    id: "groq".to_string(),
                    name: "Groq Cloud".to_string(),
                    kind: "groq".to_string(),
                    base_url: "https://api.groq.com/openai/v1".to_string(),
                    api_key_env: "GROQ_API_KEY".to_string(),
                    api_key: String::new(),
                    custom_headers: HashMap::new(),
                    models: vec![
                        "llama-3.3-70b-versatile".to_string(),
                        "llama-3.1-8b-instant".to_string(),
                        "qwen/qwen3-32b".to_string(),
                        "openai/gpt-oss-120b".to_string(),
                        "moonshotai/kimi-k2-instruct".to_string(),
                    ],
                },
                ProviderConfig {
                    id: "litellm".to_string(),
                    name: "LiteLLM Proxy".to_string(),
                    kind: "litellm".to_string(),
                    base_url: "http://localhost:4100/v1".to_string(),
                    api_key_env: "LITELLM_API_KEY".to_string(),
                    api_key: String::new(),
                    custom_headers: HashMap::new(),
                    models: vec![
                        "gpt-4o-mini".to_string(),
                        "claude-3-7-sonnet".to_string(),
                        "gemini/gemini-2.5-flash".to_string(),
                        "deepseek/deepseek-chat".to_string(),
                    ],
                },
                ProviderConfig {
                    id: "openai".to_string(),
                    name: "OpenAI API".to_string(),
                    kind: "openai".to_string(),
                    base_url: "https://api.openai.com/v1".to_string(),
                    api_key_env: "OPENAI_API_KEY".to_string(),
                    api_key: String::new(),
                    custom_headers: HashMap::new(),
                    models: vec!["gpt-4o-mini".to_string()],
                },
            ],
            targets: vec![
                TargetConfig {
                    id: "target-ollama-llama".to_string(),
                    provider_id: "ollama-local".to_string(),
                    model: "llama3.2:latest".to_string(),
                    enabled: true,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-ollama-qwen".to_string(),
                    provider_id: "ollama-local".to_string(),
                    model: "qwen2.5-coder:7b".to_string(),
                    enabled: true,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-groq-llama70b".to_string(),
                    provider_id: "groq".to_string(),
                    model: "llama-3.3-70b-versatile".to_string(),
                    enabled: false,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-groq-llama8b".to_string(),
                    provider_id: "groq".to_string(),
                    model: "llama-3.1-8b-instant".to_string(),
                    enabled: false,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-groq-qwen3".to_string(),
                    provider_id: "groq".to_string(),
                    model: "qwen/qwen3-32b".to_string(),
                    enabled: false,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-litellm-gpt4o-mini".to_string(),
                    provider_id: "litellm".to_string(),
                    model: "gpt-4o-mini".to_string(),
                    enabled: false,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-litellm-claude".to_string(),
                    provider_id: "litellm".to_string(),
                    model: "claude-3-7-sonnet".to_string(),
                    enabled: false,
                    system_prompt_override: None,
                },
                TargetConfig {
                    id: "target-litellm-gemini".to_string(),
                    provider_id: "litellm".to_string(),
                    model: "gemini/gemini-2.5-flash".to_string(),
                    enabled: false,
                    system_prompt_override: None,
                },
            ],
            subgroups: Vec::new(),
            endpoint_files: Vec::new(),
        }
    }
}

pub struct LoadedConfig {
    pub config: BenchConfig,
    pub source_path: PathBuf,
    pub from_disk: bool,
}

impl BenchConfig {
    pub fn default_user_config_path() -> PathBuf {
        if let Some(proj) = ProjectDirs::from("dev", "benchforge", "benchforge") {
            return proj.config_dir().join("config.toml");
        }
        PathBuf::from("benchforge.toml")
    }

    pub fn data_dir() -> PathBuf {
        if let Some(proj) = ProjectDirs::from("dev", "benchforge", "benchforge") {
            return proj.data_local_dir().to_path_buf();
        }
        PathBuf::from(".benchforge")
    }

    /// Resolves configuration file path in order:
    /// 1. Explicit `--config` path
    /// 2. `./benchforge.toml`
    /// 3. `~/.config/benchforge/config.toml`
    pub fn discover_path(explicit: Option<&Path>) -> (PathBuf, bool) {
        if let Some(path) = explicit {
            return (path.to_path_buf(), path.exists());
        }
        let local = PathBuf::from("benchforge.toml");
        if local.exists() {
            return (local, true);
        }
        let user_cfg = Self::default_user_config_path();
        if user_cfg.exists() {
            return (user_cfg, true);
        }
        (local, false)
    }

    pub fn load(explicit: Option<&Path>) -> Result<LoadedConfig> {
        let (path, exists) = Self::discover_path(explicit);
        let mut config = if exists {
            let raw = fs::read_to_string(&path)
                .with_context(|| format!("Failed to read config file at {}", path.display()))?;
            toml::from_str::<BenchConfig>(&raw)
                .with_context(|| format!("Invalid TOML syntax in {}", path.display()))?
        } else {
            if explicit.is_some() {
                bail!("Specified config file does not exist: {}", path.display());
            }
            BenchConfig::default()
        };

        config.apply_env_overrides();
        config.validate()?;

        Ok(LoadedConfig {
            config,
            source_path: path,
            from_disk: exists,
        })
    }

    pub fn apply_env_overrides(&mut self) {
        if let Ok(theme_raw) = env::var("BENCHFORGE_THEME") {
            if let Some(parsed) = ThemeId::from_str_lossy(&theme_raw) {
                self.ui.theme = parsed;
            }
        }
        if let Ok(conc_raw) = env::var("BENCHFORGE_CONCURRENCY") {
            if let Ok(val) = conc_raw.parse::<usize>() {
                self.execution.concurrency = val.clamp(1, 100);
            }
        }
        if let Ok(timeout_raw) = env::var("BENCHFORGE_TIMEOUT") {
            if let Ok(val) = timeout_raw.parse::<u64>() {
                self.execution.timeout_sec = val.clamp(5, 600);
            }
        }
    }

    pub fn validate(&self) -> Result<()> {
        if !(1..=100).contains(&self.execution.concurrency) {
            bail!(
                "execution.concurrency must be between 1 and 100 (got {})",
                self.execution.concurrency
            );
        }
        if self.execution.timeout_sec == 0 || self.execution.timeout_sec > 600 {
            bail!(
                "execution.timeout_sec must be between 1 and 600 (got {})",
                self.execution.timeout_sec
            );
        }
        if self.providers.is_empty() {
            bail!("At least one [[providers]] entry must be configured");
        }
        for target in &self.targets {
            if !self.providers.iter().any(|p| p.id == target.provider_id) {
                bail!(
                    "Target '{}' references unknown provider_id '{}'",
                    target.id,
                    target.provider_id
                );
            }
        }
        Ok(())
    }

    pub fn backup_path_for(path: &Path) -> PathBuf {
        let mut os = path.as_os_str().to_os_string();
        os.push(".bak");
        PathBuf::from(os)
    }

    pub fn save_with_backup(&self, path: &Path) -> Result<Option<PathBuf>> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let backup = if path.exists() {
            let bak = Self::backup_path_for(path);
            fs::copy(path, &bak).with_context(|| {
                format!("Failed to create config backup at {}", bak.display())
            })?;
            Some(bak)
        } else {
            None
        };
        let serialized = toml::to_string_pretty(self).context("Failed to serialize config to TOML")?;
        fs::write(path, serialized)
            .with_context(|| format!("Failed to write config to {}", path.display()))?;
        Ok(backup)
    }

    pub fn save_to_path(&self, path: &Path) -> Result<()> {
        self.save_with_backup(path).map(|_| ())
    }

    pub fn find_provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn enabled_targets(&self) -> Vec<&TargetConfig> {
        self.targets.iter().filter(|t| t.enabled).collect()
    }

    pub fn matching_endpoint_files(&self) -> Vec<&EndpointFileConfig> {
        let active_id = self.execution.endpoint_type.as_id();
        self.endpoint_files
            .iter()
            .filter(|f| {
                f.enabled
                    && !f.path.trim().is_empty()
                    && (f.endpoint_type == "all" || f.endpoint_type == active_id)
            })
            .collect()
    }

    pub fn provider_target_counts(&self, provider_id: &str) -> (usize, usize) {
        let mut enabled = 0usize;
        let mut total = 0usize;
        for t in &self.targets {
            if t.provider_id == provider_id {
                total += 1;
                if t.enabled {
                    enabled += 1;
                }
            }
        }
        (enabled, total)
    }

    /// Rapidly enables all models for a provider if none or only some are active;
    /// disables all of its models if all are currently active.
    pub fn toggle_provider_targets(&mut self, provider_id: &str) -> (bool, usize) {
        let (enabled, total) = self.provider_target_counts(provider_id);
        if total == 0 {
            if let Some(provider) = self.providers.iter().find(|p| p.id == provider_id).cloned() {
                for model in &provider.models {
                    let id = sanitize_target_id(provider_id, model);
                    self.targets.push(TargetConfig {
                        id,
                        provider_id: provider_id.to_string(),
                        model: model.clone(),
                        enabled: true,
                        system_prompt_override: None,
                    });
                }
                return (true, provider.models.len());
            }
            return (false, 0);
        }

        let next_state = enabled < total;
        let mut count = 0usize;
        for t in &mut self.targets {
            if t.provider_id == provider_id {
                t.enabled = next_state;
                count += 1;
            }
        }
        (next_state, count)
    }

    /// Aggregates discovered models into `provider.models` and `self.targets`,
    /// deduplicating existing entries and returning `(added_to_provider, added_to_targets)`.
    pub fn aggregate_provider_models(
        &mut self,
        provider_id: &str,
        discovered: &[String],
    ) -> (usize, usize) {
        let mut added_provider = 0usize;
        let mut added_targets = 0usize;

        if let Some(provider) = self.providers.iter_mut().find(|p| p.id == provider_id) {
            for model in discovered {
                let clean = model.trim();
                if clean.is_empty() {
                    continue;
                }
                if !provider.models.iter().any(|m| m == clean) {
                    provider.models.push(clean.to_string());
                    added_provider += 1;
                }
            }
        }

        for model in discovered {
            let clean = model.trim();
            if clean.is_empty() {
                continue;
            }
            let exists = self
                .targets
                .iter()
                .any(|t| t.provider_id == provider_id && t.model == clean);
            if !exists {
                let mut candidate_id = sanitize_target_id(provider_id, clean);
                let mut suffix = 2usize;
                while self.targets.iter().any(|t| t.id == candidate_id) {
                    candidate_id = format!("{}-{}", sanitize_target_id(provider_id, clean), suffix);
                    suffix += 1;
                }
                self.targets.push(TargetConfig {
                    id: candidate_id,
                    provider_id: provider_id.to_string(),
                    model: clean.to_string(),
                    enabled: false,
                    system_prompt_override: None,
                });
                added_targets += 1;
            }
        }

        (added_provider, added_targets)
    }

    pub fn subgroup_target_counts(&self, subgroup_id: &str) -> (usize, usize) {
        let Some(sg) = self.subgroups.iter().find(|s| s.id == subgroup_id) else {
            return (0, 0);
        };
        let mut enabled = 0usize;
        let mut total = 0usize;
        for t in &self.targets {
            if sg.target_ids.iter().any(|id| id == &t.id) {
                total += 1;
                if t.enabled {
                    enabled += 1;
                }
            }
        }
        (enabled, total)
    }

    /// Saves or updates a named model subgroup storing both the active filter text
    /// and selected target IDs cleanly into `benchforge.toml`.
    pub fn save_subgroup(
        &mut self,
        name: &str,
        filter: &str,
        target_ids: Vec<String>,
    ) -> &SubgroupConfig {
        let clean_name = name.trim();
        let display_name = if clean_name.is_empty() {
            "unnamed"
        } else {
            clean_name
        };
        let clean_filter = filter.trim().to_string();
        let mut dedup_ids = Vec::new();
        for id in target_ids {
            if !dedup_ids.contains(&id) {
                dedup_ids.push(id);
            }
        }
        let sg_id = sanitize_subgroup_id(display_name);

        if let Some(pos) = self
            .subgroups
            .iter()
            .position(|s| s.id == sg_id || s.name.eq_ignore_ascii_case(display_name))
        {
            let sg = &mut self.subgroups[pos];
            sg.name = display_name.to_string();
            sg.filter = clean_filter;
            sg.target_ids = dedup_ids;
            return &self.subgroups[pos];
        }

        self.subgroups.push(SubgroupConfig {
            id: sg_id,
            name: display_name.to_string(),
            filter: clean_filter,
            target_ids: dedup_ids,
        });
        let last = self.subgroups.len() - 1;
        &self.subgroups[last]
    }

    pub fn delete_subgroup(&mut self, subgroup_id: &str) -> Option<SubgroupConfig> {
        let pos = self.subgroups.iter().position(|s| s.id == subgroup_id)?;
        Some(self.subgroups.remove(pos))
    }

    pub fn toggle_subgroup_targets(
        &mut self,
        subgroup_id: &str,
    ) -> Option<(String, String, bool, usize)> {
        let sg = self.subgroups.iter().find(|s| s.id == subgroup_id)?.clone();
        let (enabled, total) = self.subgroup_target_counts(&sg.id);
        let next_state = enabled < total;
        let mut affected = 0usize;
        for t in &mut self.targets {
            if sg.target_ids.iter().any(|id| id == &t.id) {
                t.enabled = next_state;
                affected += 1;
            }
        }
        Some((sg.name, sg.filter, next_state, affected))
    }

    pub fn solo_subgroup_targets(&mut self, subgroup_id: &str) -> Option<(String, String, usize)> {
        let sg = self.subgroups.iter().find(|s| s.id == subgroup_id)?.clone();
        let mut active = 0usize;
        for t in &mut self.targets {
            let member = sg.target_ids.iter().any(|id| id == &t.id);
            t.enabled = member;
            if member {
                active += 1;
            }
        }
        Some((sg.name, sg.filter, active))
    }
}

fn sanitize_subgroup_id(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = clean.trim_matches('-');
    if trimmed.is_empty() {
        "subgroup-custom".to_string()
    } else {
        format!("subgroup-{}", trimmed)
    }
}

fn sanitize_target_id(provider_id: &str, model: &str) -> String {
    let clean_model: String = model
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = clean_model.trim_matches('-');
    format!("target-{}-{}", provider_id, trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let cfg = BenchConfig::default();
        assert!(cfg.validate().is_ok());
        assert_eq!(cfg.execution.concurrency, 3);
        assert_eq!(cfg.execution.timeout_sec, 300);
    }

    #[test]
    fn parses_toml_roundtrip() {
        let original = BenchConfig::default();
        let toml_str = toml::to_string_pretty(&original).expect("serialize");
        let decoded: BenchConfig = toml::from_str(&toml_str).expect("deserialize");
        assert_eq!(decoded.providers.len(), original.providers.len());
        assert_eq!(decoded.targets.len(), original.targets.len());
        assert_eq!(decoded.ui.theme, ThemeId::Dark);
    }

    #[test]
    fn rejects_invalid_concurrency_and_missing_provider() {
        let mut cfg = BenchConfig::default();
        cfg.execution.concurrency = 150;
        assert!(cfg.validate().is_err());

        cfg.execution.concurrency = 100;
        assert!(cfg.validate().is_ok());

        cfg.execution.concurrency = 3;
        cfg.targets.push(TargetConfig {
            id: "bad".into(),
            provider_id: "nonexistent".into(),
            model: "m".into(),
            enabled: true,
            system_prompt_override: None,
        });
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn resolves_api_key_from_env_when_inline_empty() {
        env::set_var("TEST_BENCHFORGE_KEY", "sk-env-123");
        let p = ProviderConfig {
            api_key_env: "TEST_BENCHFORGE_KEY".into(),
            api_key: String::new(),
            ..Default::default()
        };
        assert_eq!(p.resolve_api_key().as_deref(), Some("sk-env-123"));
        env::remove_var("TEST_BENCHFORGE_KEY");
    }

    #[test]
    fn default_config_includes_litellm_and_groq_models() {
        let cfg = BenchConfig::default();
        let litellm = cfg.find_provider("litellm").expect("litellm provider");
        assert_eq!(litellm.base_url, "http://localhost:4100/v1");
        assert_eq!(litellm.api_key_env, "LITELLM_API_KEY");
        assert!(litellm.models.contains(&"gpt-4o-mini".to_string()));

        let groq = cfg.find_provider("groq").expect("groq provider");
        assert!(groq.models.contains(&"llama-3.3-70b-versatile".to_string()));
        assert!(groq.models.contains(&"llama-3.1-8b-instant".to_string()));
        assert!(groq.models.contains(&"qwen/qwen3-32b".to_string()));
    }

    #[test]
    fn aggregates_discovered_models_and_toggles_provider_targets() {
        let mut cfg = BenchConfig::default();
        let (added_p, added_t) = cfg.aggregate_provider_models(
            "groq",
            &[
                "llama-3.3-70b-versatile".to_string(),
                "deepseek-r1-distill-llama-70b".to_string(),
            ],
        );
        assert_eq!(added_p, 1);
        assert_eq!(added_t, 1);

        let (enabled_before, total) = cfg.provider_target_counts("groq");
        assert_eq!(enabled_before, 0);
        assert!(total >= 4);

        let (new_state, affected) = cfg.toggle_provider_targets("groq");
        assert!(new_state);
        assert_eq!(affected, total);
        assert_eq!(cfg.provider_target_counts("groq").0, total);

        let (off_state, _) = cfg.toggle_provider_targets("groq");
        assert!(!off_state);
        assert_eq!(cfg.provider_target_counts("groq").0, 0);
    }

    #[test]
    fn save_with_backup_preserves_previous_toml() {
        let mut dir = env::temp_dir();
        dir.push(format!("benchforge-bak-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("mkdir");
        let cfg_path = dir.join("benchforge.toml");

        let mut cfg1 = BenchConfig::default();
        cfg1.execution.concurrency = 2;
        let first_bak = cfg1.save_with_backup(&cfg_path).expect("first save");
        assert!(first_bak.is_none());
        let original_toml = fs::read_to_string(&cfg_path).expect("read original");

        let mut cfg2 = cfg1.clone();
        cfg2.execution.concurrency = 7;
        let second_bak = cfg2
            .save_with_backup(&cfg_path)
            .expect("second save")
            .expect("backup created");
        assert_eq!(second_bak, BenchConfig::backup_path_for(&cfg_path));
        assert_eq!(fs::read_to_string(&second_bak).expect("read bak"), original_toml);

        let updated_toml = fs::read_to_string(&cfg_path).expect("read updated");
        assert!(updated_toml.contains("concurrency = 7"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saves_applies_and_persists_subgroups_in_toml() {
        let mut cfg = BenchConfig::default();
        let groq_ids: Vec<String> = cfg
            .targets
            .iter()
            .filter(|t| t.provider_id == "groq")
            .take(2)
            .map(|t| t.id.clone())
            .collect();
        let saved_id = cfg
            .save_subgroup("Groq Fast", "groq", groq_ids.clone())
            .id
            .clone();
        assert_eq!(cfg.subgroups.len(), 1);
        assert_eq!(cfg.subgroups[0].filter, "groq");

        let (name, filter, enabled_count) = cfg.solo_subgroup_targets(&saved_id).expect("solo");
        assert_eq!(name, "Groq Fast");
        assert_eq!(filter, "groq");
        assert_eq!(enabled_count, 2);
        assert_eq!(cfg.enabled_targets().len(), 2);

        let toml_str = toml::to_string_pretty(&cfg).expect("serialize");
        let decoded: BenchConfig = toml::from_str(&toml_str).expect("deserialize");
        assert_eq!(decoded.subgroups.len(), 1);
        assert_eq!(decoded.subgroups[0].target_ids, groq_ids);

        let removed = cfg.delete_subgroup(&saved_id).expect("delete");
        assert_eq!(removed.name, "Groq Fast");
        assert!(cfg.subgroups.is_empty());
    }

    #[test]
    fn supports_endpoint_type_and_endpoint_files_roundtrip() {
        let mut cfg = BenchConfig::default();
        cfg.execution.concurrency = 100;
        cfg.execution.endpoint_type = EndpointType::AudioTranscriptions;
        cfg.endpoint_files.push(EndpointFileConfig {
            id: "f-audio".into(),
            path: "/tmp/sample.mp3".into(),
            mime_type: "audio/mpeg".into(),
            endpoint_type: "audio-transcriptions".into(),
            field_name: "file".into(),
            enabled: true,
        });
        assert!(cfg.validate().is_ok());
        assert_eq!(cfg.matching_endpoint_files().len(), 1);

        let toml_str = toml::to_string_pretty(&cfg).expect("serialize");
        let decoded: BenchConfig = toml::from_str(&toml_str).expect("deserialize");
        assert_eq!(decoded.execution.concurrency, 100);
        assert_eq!(decoded.execution.endpoint_type, EndpointType::AudioTranscriptions);
        assert_eq!(decoded.endpoint_files.len(), 1);
        assert!(!decoded.execution.randomize_order);
    }
}

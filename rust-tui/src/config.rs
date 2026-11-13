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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExecutionConfig {
    pub mode: ExecutionMode,
    pub concurrency: usize,
    pub timeout_sec: u64,
    pub stream: bool,
    pub temperature: f32,
    pub max_tokens: u32,
    pub top_p: f32,
    pub seed: Option<u64>,
}

impl Default for ExecutionConfig {
    fn default() -> Self {
        Self {
            mode: ExecutionMode::Parallel,
            concurrency: 3,
            timeout_sec: 300,
            stream: true,
            temperature: 0.7,
            max_tokens: 2048,
            top_p: 1.0,
            seed: None,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BenchConfig {
    pub execution: ExecutionConfig,
    pub system_prompt: SystemPromptConfig,
    pub ui: UiConfig,
    pub supabase: SupabaseConfig,
    pub providers: Vec<ProviderConfig>,
    pub targets: Vec<TargetConfig>,
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
                    models: vec!["llama-3.3-70b-versatile".to_string()],
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
            ],
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
                self.execution.concurrency = val.clamp(1, 10);
            }
        }
        if let Ok(timeout_raw) = env::var("BENCHFORGE_TIMEOUT") {
            if let Ok(val) = timeout_raw.parse::<u64>() {
                self.execution.timeout_sec = val.clamp(5, 600);
            }
        }
    }

    pub fn validate(&self) -> Result<()> {
        if !(1..=10).contains(&self.execution.concurrency) {
            bail!(
                "execution.concurrency must be between 1 and 10 (got {})",
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

    pub fn save_to_path(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let serialized = toml::to_string_pretty(self).context("Failed to serialize config to TOML")?;
        fs::write(path, serialized)
            .with_context(|| format!("Failed to write config to {}", path.display()))?;
        Ok(())
    }

    pub fn find_provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn enabled_targets(&self) -> Vec<&TargetConfig> {
        self.targets.iter().filter(|t| t.enabled).collect()
    }
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
        cfg.execution.concurrency = 15;
        assert!(cfg.validate().is_err());

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
}

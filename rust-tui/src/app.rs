use crate::config::{BenchConfig, ExecutionMode, ThemeId};
use crate::engine::{
    spawn_benchmark_batch, spawn_refresh_provider_models, EngineEvent, ModelRunResult, RunStatus,
};
use crate::export::{export_bundle, load_history, push_run_supabase, save_run_to_history, BenchmarkRunRecord};
use crate::suites::{PROMPT_SUITES, SYSTEM_PERSONAS};
use chrono::Utc;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::{mpsc, watch};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveTab {
    PromptSuites,
    Responses,
    Waterfall,
    DiffCompare,
    CapabilityGraph,
    ConfigEditor,
}

impl ActiveTab {
    pub fn index(self) -> usize {
        match self {
            ActiveTab::PromptSuites => 0,
            ActiveTab::Responses => 1,
            ActiveTab::Waterfall => 2,
            ActiveTab::DiffCompare => 3,
            ActiveTab::CapabilityGraph => 4,
            ActiveTab::ConfigEditor => 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFocus {
    Providers,
    Models,
}

pub struct AppState {
    pub config: BenchConfig,
    pub config_path: PathBuf,
    pub config_dirty: bool,
    pub active_tab: ActiveTab,
    pub config_focus: ConfigFocus,
    pub editing_prompt: bool,
    pub prompt: String,
    pub run_title: String,
    pub selected_suite_idx: usize,
    pub selected_result_idx: usize,
    pub selected_provider_idx: usize,
    pub selected_config_idx: usize,
    pub refreshing_providers: HashSet<String>,
    pub diff_left_idx: usize,
    pub diff_right_idx: usize,
    pub output_scroll: u16,
    pub results: HashMap<String, ModelRunResult>,
    pub history: Vec<BenchmarkRunRecord>,
    pub is_running: bool,
    pub status_message: String,
    pub should_quit: bool,
    pub engine_tx: mpsc::UnboundedSender<EngineEvent>,
    pub abort_tx: Option<watch::Sender<bool>>,
}

impl AppState {
    pub fn new(
        config: BenchConfig,
        config_path: PathBuf,
        from_disk: bool,
        engine_tx: mpsc::UnboundedSender<EngineEvent>,
    ) -> Self {
        let history = load_history(config.ui.history_limit);
        let first_suite = &PROMPT_SUITES[0];
        let status_message = if from_disk {
            format!("Loaded config: {}", config_path.display())
        } else {
            format!(
                "Using defaults (press 's' to save {})",
                config_path.display()
            )
        };

        Self {
            config,
            config_path,
            config_dirty: !from_disk,
            active_tab: ActiveTab::PromptSuites,
            config_focus: ConfigFocus::Providers,
            editing_prompt: false,
            prompt: first_suite.prompt.to_string(),
            run_title: first_suite.title.to_string(),
            selected_suite_idx: 0,
            selected_result_idx: 0,
            selected_provider_idx: 0,
            selected_config_idx: 0,
            refreshing_providers: HashSet::new(),
            diff_left_idx: 0,
            diff_right_idx: 1,
            output_scroll: 0,
            results: HashMap::new(),
            history,
            is_running: false,
            status_message,
            should_quit: false,
            engine_tx,
            abort_tx: None,
        }
    }

    pub fn theme(&self) -> ThemeId {
        self.config.ui.theme
    }

    pub fn ordered_results(&self) -> Vec<ModelRunResult> {
        let mut list = Vec::new();
        for t in &self.config.targets {
            if !t.enabled && !self.results.contains_key(&t.id) {
                continue;
            }
            if let Some(res) = self.results.get(&t.id) {
                list.push(res.clone());
            } else {
                let pname = self
                    .config
                    .find_provider(&t.provider_id)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| t.provider_id.clone());
                list.push(ModelRunResult {
                    target_id: t.id.clone(),
                    model_name: t.model.clone(),
                    provider_name: pname,
                    status: RunStatus::Idle,
                    output: String::new(),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    tokens_per_sec: 0.0,
                    timing: Default::default(),
                    http_status: None,
                    error: None,
                    advice: None,
                });
            }
        }
        list
    }

    pub fn start_run(&mut self, retry_failed_only: bool) {
        if self.is_running {
            return;
        }
        let targets: Vec<_> = self
            .config
            .targets
            .iter()
            .filter(|t| {
                if !t.enabled {
                    return false;
                }
                if !retry_failed_only {
                    return true;
                }
                match self.results.get(&t.id) {
                    None => true,
                    Some(r) => matches!(
                        r.status,
                        RunStatus::Idle | RunStatus::Error | RunStatus::Aborted | RunStatus::Queued
                    ),
                }
            })
            .cloned()
            .collect();

        if targets.is_empty() {
            self.status_message = if retry_failed_only {
                "No failed or idle targets to retry.".to_string()
            } else {
                "Enable at least one target in Config (6).".to_string()
            };
            return;
        }

        if !retry_failed_only {
            self.results.clear();
        }
        let (abort_tx, abort_rx) = watch::channel(false);
        self.abort_tx = Some(abort_tx);
        self.is_running = true;
        self.active_tab = ActiveTab::Responses;
        self.status_message = format!("Running {} target(s)...", targets.len());

        spawn_benchmark_batch(
            self.config.clone(),
            targets,
            self.prompt.clone(),
            self.engine_tx.clone(),
            abort_rx,
        );
    }

    pub fn abort_run(&mut self) {
        if let Some(ref tx) = self.abort_tx {
            let _ = tx.send(true);
            self.status_message = "Aborting active run...".to_string();
        }
    }

    pub fn handle_engine_event(&mut self, ev: EngineEvent) {
        match ev {
            EngineEvent::Update(res) => {
                self.results.insert(res.target_id.clone(), res);
            }
            EngineEvent::BatchFinished => {
                self.is_running = false;
                self.abort_tx = None;
                let completed = self.ordered_results();
                let record = BenchmarkRunRecord {
                    id: format!("run-{}", Utc::now().timestamp_millis()),
                    title: self.run_title.clone(),
                    created_at: Utc::now(),
                    prompt: self.prompt.clone(),
                    results: completed,
                };
                if let Ok(updated) = save_run_to_history(record.clone(), self.config.ui.history_limit) {
                    self.history = updated;
                }
                if self.config.supabase.auto_sync && !self.config.supabase.url.trim().is_empty() {
                    let sb = self.config.supabase.clone();
                    tokio::spawn(async move {
                        let _ = push_run_supabase(&sb, &record).await;
                    });
                }
                self.status_message = "Benchmark batch finished and saved to local history.".to_string();
            }
            EngineEvent::ModelsRefreshed {
                provider_id,
                provider_name,
                result,
            } => {
                self.refreshing_providers.remove(&provider_id);
                match result {
                    Ok(models) => {
                        let discovered_len = models.len();
                        let (added_p, added_t) =
                            self.config.aggregate_provider_models(&provider_id, &models);
                        if added_p > 0 || added_t > 0 {
                            match self.config.save_to_path(&self.config_path) {
                                Ok(()) => {
                                    self.config_dirty = false;
                                    self.status_message = format!(
                                        "Refreshed {}: {} models (+{} provider, +{} targets) -> saved {}",
                                        provider_name,
                                        discovered_len,
                                        added_p,
                                        added_t,
                                        self.config_path.display()
                                    );
                                }
                                Err(err) => {
                                    self.config_dirty = true;
                                    self.status_message = format!(
                                        "Refreshed {} (+{} targets), save error: {}",
                                        provider_name, added_t, err
                                    );
                                }
                            }
                        } else {
                            self.status_message = format!(
                                "Refreshed {}: {} models (already up to date)",
                                provider_name, discovered_len
                            );
                        }
                    }
                    Err(err) => {
                        self.status_message =
                            format!("Refresh {} failed: {}", provider_name, err);
                    }
                }
            }
        }
    }

    pub fn refresh_selected_provider(&mut self) {
        let provider_opt = match self.config_focus {
            ConfigFocus::Providers => self.config.providers.get(self.selected_provider_idx).cloned(),
            ConfigFocus::Models => self
                .config
                .targets
                .get(self.selected_config_idx)
                .and_then(|t| self.config.find_provider(&t.provider_id))
                .cloned()
                .or_else(|| self.config.providers.get(self.selected_provider_idx).cloned()),
        };

        if let Some(provider) = provider_opt {
            if self.refreshing_providers.contains(&provider.id) {
                return;
            }
            self.refreshing_providers.insert(provider.id.clone());
            self.status_message = format!("Refreshing models from {} ({})...", provider.name, provider.base_url);
            spawn_refresh_provider_models(provider, self.engine_tx.clone());
        }
    }

    pub fn refresh_all_providers(&mut self) {
        let mut started = 0usize;
        for provider in &self.config.providers {
            if !self.refreshing_providers.contains(&provider.id) {
                self.refreshing_providers.insert(provider.id.clone());
                spawn_refresh_provider_models(provider.clone(), self.engine_tx.clone());
                started += 1;
            }
        }
        if started > 0 {
            self.status_message = format!("Refreshing models from {} provider(s)...", started);
        }
    }

    pub fn save_config(&mut self) {
        if let Err(err) = self.config.validate() {
            self.status_message = format!("Config validation failed: {}", err);
            return;
        }
        match self.config.save_to_path(&self.config_path) {
            Ok(()) => {
                self.config_dirty = false;
                self.status_message = format!("Saved config to {}", self.config_path.display());
            }
            Err(err) => {
                self.status_message = format!("Save failed: {}", err);
            }
        }
    }

    pub fn export_results(&mut self) {
        let record = BenchmarkRunRecord {
            id: format!("export-{}", Utc::now().timestamp_millis()),
            title: self.run_title.clone(),
            created_at: Utc::now(),
            prompt: self.prompt.clone(),
            results: self.ordered_results(),
        };
        let export_dir = PathBuf::from("exports");
        match export_bundle(&export_dir, &record) {
            Ok((j, c)) => {
                self.status_message = format!("Exported {} & {}", j.display(), c.display());
            }
            Err(err) => {
                self.status_message = format!("Export failed: {}", err);
            }
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }

        if self.editing_prompt {
            match key.code {
                KeyCode::Esc => {
                    self.editing_prompt = false;
                    self.status_message = "Prompt edit saved.".to_string();
                }
                KeyCode::Backspace => {
                    self.prompt.pop();
                }
                KeyCode::Enter => {
                    self.prompt.push('\n');
                }
                KeyCode::Char(c) => {
                    self.prompt.push(c);
                }
                _ => {}
            }
            return;
        }

        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('1') => self.active_tab = ActiveTab::PromptSuites,
            KeyCode::Char('2') => self.active_tab = ActiveTab::Responses,
            KeyCode::Char('3') => self.active_tab = ActiveTab::Waterfall,
            KeyCode::Char('4') => self.active_tab = ActiveTab::DiffCompare,
            KeyCode::Char('5') => self.active_tab = ActiveTab::CapabilityGraph,
            KeyCode::Char('6') => self.active_tab = ActiveTab::ConfigEditor,
            KeyCode::Char('t') => {
                self.config.ui.theme = self.config.ui.theme.next();
                self.config_dirty = true;
                self.status_message = format!("Theme: {}", self.config.ui.theme.label());
            }
            KeyCode::Char('r') => self.start_run(false),
            KeyCode::Char('R') => self.start_run(true),
            KeyCode::Char('x') => self.abort_run(),
            KeyCode::Char('s') => self.save_config(),
            KeyCode::Char('e') => self.export_results(),
            KeyCode::Char('i') if self.active_tab == ActiveTab::PromptSuites => {
                self.editing_prompt = true;
                self.status_message = "Editing prompt (press Esc when done)".to_string();
            }
            KeyCode::Tab => {
                self.active_tab = match self.active_tab {
                    ActiveTab::PromptSuites => ActiveTab::Responses,
                    ActiveTab::Responses => ActiveTab::Waterfall,
                    ActiveTab::Waterfall => ActiveTab::DiffCompare,
                    ActiveTab::DiffCompare => ActiveTab::CapabilityGraph,
                    ActiveTab::CapabilityGraph => ActiveTab::ConfigEditor,
                    ActiveTab::ConfigEditor => ActiveTab::PromptSuites,
                };
            }
            KeyCode::Up | KeyCode::Char('k') => self.navigate_up(),
            KeyCode::Down | KeyCode::Char('j') => self.navigate_down(),
            KeyCode::Enter | KeyCode::Char(' ') => self.activate_selected(),
            KeyCode::Char('+') | KeyCode::Char('=') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.concurrency = (self.config.execution.concurrency + 1).min(10);
                self.config_dirty = true;
            }
            KeyCode::Char('-') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.concurrency = self.config.execution.concurrency.saturating_sub(1).max(1);
                self.config_dirty = true;
            }
            KeyCode::Char(']') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.timeout_sec = (self.config.execution.timeout_sec + 30).min(600);
                self.config_dirty = true;
            }
            KeyCode::Char('[') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.timeout_sec = self.config.execution.timeout_sec.saturating_sub(30).max(10);
                self.config_dirty = true;
            }
            KeyCode::Char('m') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.mode = match self.config.execution.mode {
                    ExecutionMode::Parallel => ExecutionMode::Sequential,
                    ExecutionMode::Sequential => ExecutionMode::Parallel,
                };
                self.config_dirty = true;
            }
            KeyCode::Char('v') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.stream = !self.config.execution.stream;
                self.config_dirty = true;
            }
            KeyCode::Char('p') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.system_prompt.enabled = !self.config.system_prompt.enabled;
                self.config_dirty = true;
            }
            KeyCode::Char('P') if self.active_tab == ActiveTab::ConfigEditor => {
                let cur_idx = self
                    .config
                    .system_prompt
                    .persona
                    .as_deref()
                    .and_then(|id| SYSTEM_PERSONAS.iter().position(|p| p.id == id))
                    .unwrap_or(0);
                let next = &SYSTEM_PERSONAS[(cur_idx + 1) % SYSTEM_PERSONAS.len()];
                self.config.system_prompt.persona = Some(next.id.to_string());
                self.config.system_prompt.enabled = true;
                self.config_dirty = true;
                self.status_message = format!("Persona: {}", next.name);
            }
            KeyCode::Char('d') if self.active_tab == ActiveTab::ConfigEditor => {
                self.refresh_selected_provider();
            }
            KeyCode::Char('D') if self.active_tab == ActiveTab::ConfigEditor => {
                self.refresh_all_providers();
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Char('h') | KeyCode::Char('l')
                if self.active_tab == ActiveTab::ConfigEditor =>
            {
                self.config_focus = match self.config_focus {
                    ConfigFocus::Providers => ConfigFocus::Models,
                    ConfigFocus::Models => ConfigFocus::Providers,
                };
            }
            KeyCode::Char('a') if self.active_tab == ActiveTab::DiffCompare => {
                let len = self.ordered_results().len().max(1);
                self.diff_left_idx = (self.diff_left_idx + 1) % len;
            }
            KeyCode::Char('b') if self.active_tab == ActiveTab::DiffCompare => {
                let len = self.ordered_results().len().max(1);
                self.diff_right_idx = (self.diff_right_idx + 1) % len;
            }
            _ => {}
        }
    }

    fn navigate_up(&mut self) {
        match self.active_tab {
            ActiveTab::PromptSuites => {
                self.selected_suite_idx = self.selected_suite_idx.saturating_sub(1);
            }
            ActiveTab::Responses => {
                if self.output_scroll > 0 {
                    self.output_scroll = self.output_scroll.saturating_sub(2);
                } else {
                    self.selected_result_idx = self.selected_result_idx.saturating_sub(1);
                }
            }
            ActiveTab::ConfigEditor => match self.config_focus {
                ConfigFocus::Providers => {
                    self.selected_provider_idx = self.selected_provider_idx.saturating_sub(1);
                }
                ConfigFocus::Models => {
                    self.selected_config_idx = self.selected_config_idx.saturating_sub(1);
                }
            },
            _ => {}
        }
    }

    fn navigate_down(&mut self) {
        match self.active_tab {
            ActiveTab::PromptSuites => {
                if self.selected_suite_idx + 1 < PROMPT_SUITES.len() {
                    self.selected_suite_idx += 1;
                }
            }
            ActiveTab::Responses => {
                let len = self.ordered_results().len();
                if len > 0 && self.selected_result_idx + 1 < len {
                    self.selected_result_idx += 1;
                    self.output_scroll = 0;
                } else {
                    self.output_scroll = self.output_scroll.saturating_add(2);
                }
            }
            ActiveTab::ConfigEditor => match self.config_focus {
                ConfigFocus::Providers => {
                    if self.selected_provider_idx + 1 < self.config.providers.len() {
                        self.selected_provider_idx += 1;
                    }
                }
                ConfigFocus::Models => {
                    if self.selected_config_idx + 1 < self.config.targets.len() {
                        self.selected_config_idx += 1;
                    }
                }
            },
            _ => {}
        }
    }

    fn activate_selected(&mut self) {
        match self.active_tab {
            ActiveTab::PromptSuites => {
                if let Some(item) = PROMPT_SUITES.get(self.selected_suite_idx) {
                    self.prompt = item.prompt.to_string();
                    self.run_title = item.title.to_string();
                    self.status_message = format!("Loaded prompt: {}", item.title);
                }
            }
            ActiveTab::ConfigEditor => match self.config_focus {
                ConfigFocus::Providers => {
                    if let Some(provider) = self.config.providers.get(self.selected_provider_idx).cloned() {
                        let (new_state, affected) = self.config.toggle_provider_targets(&provider.id);
                        self.config_dirty = true;
                        self.status_message = if new_state {
                            format!("Enabled all {} model(s) for {}", affected, provider.name)
                        } else {
                            format!("Disabled all {} model(s) for {}", affected, provider.name)
                        };
                    }
                }
                ConfigFocus::Models => {
                    if let Some(target) = self.config.targets.get_mut(self.selected_config_idx) {
                        target.enabled = !target.enabled;
                        self.config_dirty = true;
                    }
                }
            },
            _ => {}
        }
    }
}

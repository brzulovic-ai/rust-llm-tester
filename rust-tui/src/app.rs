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
    ModelFilter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaterfallSortField {
    Order,
    Model,
    Status,
    Queue,
    Request,
    Ttfb,
    Download,
    Total,
    Speed,
}

impl WaterfallSortField {
    pub fn label(self) -> &'static str {
        match self {
            WaterfallSortField::Order => "Config Order",
            WaterfallSortField::Model => "Model",
            WaterfallSortField::Status => "Status",
            WaterfallSortField::Queue => "Queue",
            WaterfallSortField::Request => "Request",
            WaterfallSortField::Ttfb => "TTFB",
            WaterfallSortField::Download => "Download",
            WaterfallSortField::Total => "Total",
            WaterfallSortField::Speed => "Speed",
        }
    }

    pub fn next(self) -> Self {
        match self {
            WaterfallSortField::Order => WaterfallSortField::Total,
            WaterfallSortField::Total => WaterfallSortField::Ttfb,
            WaterfallSortField::Ttfb => WaterfallSortField::Speed,
            WaterfallSortField::Speed => WaterfallSortField::Model,
            WaterfallSortField::Model => WaterfallSortField::Status,
            WaterfallSortField::Status => WaterfallSortField::Queue,
            WaterfallSortField::Queue => WaterfallSortField::Request,
            WaterfallSortField::Request => WaterfallSortField::Download,
            WaterfallSortField::Download => WaterfallSortField::Order,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            WaterfallSortField::Order => WaterfallSortField::Download,
            WaterfallSortField::Download => WaterfallSortField::Request,
            WaterfallSortField::Request => WaterfallSortField::Queue,
            WaterfallSortField::Queue => WaterfallSortField::Status,
            WaterfallSortField::Status => WaterfallSortField::Model,
            WaterfallSortField::Model => WaterfallSortField::Speed,
            WaterfallSortField::Speed => WaterfallSortField::Ttfb,
            WaterfallSortField::Ttfb => WaterfallSortField::Total,
            WaterfallSortField::Total => WaterfallSortField::Order,
        }
    }

    pub fn default_desc(self) -> bool {
        matches!(self, WaterfallSortField::Speed | WaterfallSortField::Total)
    }
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
    pub model_filter: String,
    pub refreshing_providers: HashSet<String>,
    pub diff_left_idx: usize,
    pub diff_right_idx: usize,
    pub waterfall_sort: WaterfallSortField,
    pub waterfall_desc: bool,
    pub waterfall_selected_idx: usize,
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
            model_filter: String::new(),
            refreshing_providers: HashSet::new(),
            diff_left_idx: 0,
            diff_right_idx: 1,
            waterfall_sort: WaterfallSortField::Order,
            waterfall_desc: false,
            waterfall_selected_idx: 0,
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

    /// Returns indices into `self.config.targets` matching `self.model_filter`
    /// across model name, provider id, and provider display name.
    pub fn filtered_target_indices(&self) -> Vec<usize> {
        let query = self.model_filter.trim().to_lowercase();
        self.config
            .targets
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                if query.is_empty() {
                    return true;
                }
                let provider_name = self
                    .config
                    .find_provider(&t.provider_id)
                    .map(|p| p.name.as_str())
                    .unwrap_or("");
                t.model.to_lowercase().contains(&query)
                    || t.provider_id.to_lowercase().contains(&query)
                    || provider_name.to_lowercase().contains(&query)
            })
            .map(|(i, _)| i)
            .collect()
    }

    fn clamp_model_selection(&mut self) {
        let len = self.filtered_target_indices().len();
        if len == 0 {
            self.selected_config_idx = 0;
        } else if self.selected_config_idx >= len {
            self.selected_config_idx = len - 1;
        }
    }

    fn cycle_config_canvas(&mut self) {
        self.config_focus = match self.config_focus {
            ConfigFocus::Providers => ConfigFocus::Models,
            ConfigFocus::Models => ConfigFocus::ModelFilter,
            ConfigFocus::ModelFilter => ConfigFocus::Providers,
        };
        if self.config_focus == ConfigFocus::Models {
            self.clamp_model_selection();
        }
    }

    pub fn deselect_filtered_targets(&mut self) {
        let filtered = self.filtered_target_indices();
        let mut disabled_count = 0usize;
        for idx in &filtered {
            if let Some(target) = self.config.targets.get_mut(*idx) {
                if target.enabled {
                    target.enabled = false;
                    disabled_count += 1;
                }
            }
        }
        if disabled_count > 0 {
            self.config_dirty = true;
        }
        let query = self.model_filter.trim();
        self.status_message = if query.is_empty() {
            format!("Deselected {} model(s).", disabled_count)
        } else {
            format!(
                "Deselected {} matching model(s) for filter \"{}\".",
                disabled_count, query
            )
        };
    }

    pub fn select_filtered_targets(&mut self) {
        let filtered = self.filtered_target_indices();
        let mut enabled_count = 0usize;
        for idx in &filtered {
            if let Some(target) = self.config.targets.get_mut(*idx) {
                if !target.enabled {
                    target.enabled = true;
                    enabled_count += 1;
                }
            }
        }
        if enabled_count > 0 {
            self.config_dirty = true;
        }
        let query = self.model_filter.trim();
        self.status_message = if query.is_empty() {
            format!("Selected {} model(s).", enabled_count)
        } else {
            format!(
                "Selected {} matching model(s) for filter \"{}\".",
                enabled_count, query
            )
        };
    }

    pub fn sorted_waterfall_results(&self) -> Vec<ModelRunResult> {
        let mut list = self.ordered_results();
        match self.waterfall_sort {
            WaterfallSortField::Order => {
                if self.waterfall_desc {
                    list.reverse();
                }
            }
            WaterfallSortField::Model => {
                list.sort_by(|a, b| {
                    let ord = a.model_name.to_lowercase().cmp(&b.model_name.to_lowercase());
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
            WaterfallSortField::Status => {
                list.sort_by(|a, b| {
                    let ord = a.status.label().cmp(b.status.label());
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
            WaterfallSortField::Queue => {
                list.sort_by(|a, b| {
                    let ord = a.timing.queue_ms.total_cmp(&b.timing.queue_ms);
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
            WaterfallSortField::Request => {
                list.sort_by(|a, b| {
                    let ord = a.timing.request_ms.total_cmp(&b.timing.request_ms);
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
            WaterfallSortField::Ttfb => {
                list.sort_by(|a, b| match (a.timing.ttfb_ms, b.timing.ttfb_ms) {
                    (Some(va), Some(vb)) => {
                        let ord = va.total_cmp(&vb);
                        if self.waterfall_desc { ord.reverse() } else { ord }
                    }
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                });
            }
            WaterfallSortField::Download => {
                list.sort_by(|a, b| {
                    let ord = a.timing.download_ms.total_cmp(&b.timing.download_ms);
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
            WaterfallSortField::Total => {
                list.sort_by(|a, b| {
                    let ord = a.timing.total_ms.total_cmp(&b.timing.total_ms);
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
            WaterfallSortField::Speed => {
                list.sort_by(|a, b| {
                    let ord = a.tokens_per_sec.total_cmp(&b.tokens_per_sec);
                    if self.waterfall_desc { ord.reverse() } else { ord }
                });
            }
        }
        list
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
            ConfigFocus::Models | ConfigFocus::ModelFilter => {
                let filtered = self.filtered_target_indices();
                filtered
                    .get(self.selected_config_idx)
                    .and_then(|&idx| self.config.targets.get(idx))
                    .and_then(|t| self.config.find_provider(&t.provider_id))
                    .cloned()
                    .or_else(|| self.config.providers.get(self.selected_provider_idx).cloned())
            }
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

        if self.active_tab == ActiveTab::ConfigEditor
            && self.config_focus == ConfigFocus::ModelFilter
        {
            match key.code {
                KeyCode::BackTab => {
                    self.cycle_config_canvas();
                    return;
                }
                KeyCode::Tab if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    self.cycle_config_canvas();
                    return;
                }
                KeyCode::Tab => {
                    self.config_focus = ConfigFocus::Models;
                    self.clamp_model_selection();
                    self.active_tab = ActiveTab::PromptSuites;
                    return;
                }
                KeyCode::Esc => {
                    if !self.model_filter.is_empty() {
                        self.model_filter.clear();
                        self.selected_config_idx = 0;
                    }
                    self.config_focus = ConfigFocus::Models;
                    self.status_message = "Exited model filter.".to_string();
                    return;
                }
                KeyCode::Enter | KeyCode::Down => {
                    self.config_focus = ConfigFocus::Models;
                    self.clamp_model_selection();
                    return;
                }
                KeyCode::Up => {
                    self.config_focus = ConfigFocus::Providers;
                    return;
                }
                KeyCode::Backspace => {
                    self.model_filter.pop();
                    self.selected_config_idx = 0;
                    return;
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.model_filter.clear();
                    self.selected_config_idx = 0;
                    return;
                }
                KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.deselect_filtered_targets();
                    return;
                }
                KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.select_filtered_targets();
                    return;
                }
                KeyCode::Char(c) => {
                    self.model_filter.push(c);
                    self.selected_config_idx = 0;
                    return;
                }
                _ => return,
            }
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
            KeyCode::BackTab if self.active_tab == ActiveTab::ConfigEditor => {
                self.cycle_config_canvas();
            }
            KeyCode::Tab
                if self.active_tab == ActiveTab::ConfigEditor
                    && key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                self.cycle_config_canvas();
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
            KeyCode::Char('/') | KeyCode::Char('f')
                if self.active_tab == ActiveTab::ConfigEditor =>
            {
                self.config_focus = ConfigFocus::ModelFilter;
                self.status_message =
                    "Filtering models (type query, Enter/Down for list, Esc clear)".to_string();
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
            KeyCode::Char('u') if self.active_tab == ActiveTab::ConfigEditor => {
                self.deselect_filtered_targets();
            }
            KeyCode::Char('a') if self.active_tab == ActiveTab::ConfigEditor => {
                self.select_filtered_targets();
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Char('h') | KeyCode::Char('l')
                if self.active_tab == ActiveTab::ConfigEditor =>
            {
                self.cycle_config_canvas();
            }
            KeyCode::Char('o') | KeyCode::Right | KeyCode::Char('l')
                if self.active_tab == ActiveTab::Waterfall =>
            {
                self.waterfall_sort = self.waterfall_sort.next();
                self.waterfall_desc = self.waterfall_sort.default_desc();
                self.status_message = format!(
                    "Waterfall sort: {} ({})",
                    self.waterfall_sort.label(),
                    if self.waterfall_desc { "desc" } else { "asc" }
                );
            }
            KeyCode::Left | KeyCode::Char('h') if self.active_tab == ActiveTab::Waterfall => {
                self.waterfall_sort = self.waterfall_sort.prev();
                self.waterfall_desc = self.waterfall_sort.default_desc();
                self.status_message = format!(
                    "Waterfall sort: {} ({})",
                    self.waterfall_sort.label(),
                    if self.waterfall_desc { "desc" } else { "asc" }
                );
            }
            KeyCode::Char('O') | KeyCode::Char('v') if self.active_tab == ActiveTab::Waterfall => {
                self.waterfall_desc = !self.waterfall_desc;
                self.status_message = format!(
                    "Waterfall sort: {} ({})",
                    self.waterfall_sort.label(),
                    if self.waterfall_desc { "desc" } else { "asc" }
                );
            }
            KeyCode::PageDown | KeyCode::Char('J') if self.active_tab == ActiveTab::Responses => {
                self.output_scroll = self.output_scroll.saturating_add(6);
            }
            KeyCode::PageUp | KeyCode::Char('K') if self.active_tab == ActiveTab::Responses => {
                self.output_scroll = self.output_scroll.saturating_sub(6);
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
                let len = self.ordered_results().len();
                if self.selected_result_idx >= len && len > 0 {
                    self.selected_result_idx = len - 1;
                }
                if self.selected_result_idx > 0 {
                    self.selected_result_idx -= 1;
                    self.output_scroll = 0;
                } else {
                    self.output_scroll = self.output_scroll.saturating_sub(2);
                }
            }
            ActiveTab::Waterfall => {
                self.waterfall_selected_idx = self.waterfall_selected_idx.saturating_sub(1);
            }
            ActiveTab::ConfigEditor => match self.config_focus {
                ConfigFocus::Providers => {
                    self.selected_provider_idx = self.selected_provider_idx.saturating_sub(1);
                }
                ConfigFocus::Models => {
                    self.selected_config_idx = self.selected_config_idx.saturating_sub(1);
                }
                ConfigFocus::ModelFilter => {
                    self.config_focus = ConfigFocus::Providers;
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
                }
            }
            ActiveTab::Waterfall => {
                let len = self.ordered_results().len();
                if len > 0 && self.waterfall_selected_idx + 1 < len {
                    self.waterfall_selected_idx += 1;
                }
            }
            ActiveTab::ConfigEditor => match self.config_focus {
                ConfigFocus::Providers => {
                    if self.selected_provider_idx + 1 < self.config.providers.len() {
                        self.selected_provider_idx += 1;
                    }
                }
                ConfigFocus::Models => {
                    let len = self.filtered_target_indices().len();
                    if self.selected_config_idx + 1 < len {
                        self.selected_config_idx += 1;
                    }
                }
                ConfigFocus::ModelFilter => {
                    self.config_focus = ConfigFocus::Models;
                    self.clamp_model_selection();
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
            ActiveTab::Waterfall => {
                self.waterfall_desc = !self.waterfall_desc;
                self.status_message = format!(
                    "Waterfall sort: {} ({})",
                    self.waterfall_sort.label(),
                    if self.waterfall_desc { "desc" } else { "asc" }
                );
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
                    let filtered = self.filtered_target_indices();
                    if let Some(&actual_idx) = filtered.get(self.selected_config_idx) {
                        if let Some(target) = self.config.targets.get_mut(actual_idx) {
                            target.enabled = !target.enabled;
                            self.config_dirty = true;
                        }
                    }
                }
                ConfigFocus::ModelFilter => {
                    self.config_focus = ConfigFocus::Models;
                    self.clamp_model_selection();
                }
            },
            _ => {}
        }
    }
}

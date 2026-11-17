use crate::config::{BenchConfig, ExecutionMode, ThemeId};
use crate::engine::{
    spawn_benchmark_batch, spawn_refresh_provider_models, EngineEvent, ModelRunResult, RunStatus,
};
use crate::export::{export_bundle, load_history, push_run_supabase, save_run_to_history, BenchmarkRunRecord};
use crate::suites::{PING_PROBE_PROMPT, PROMPT_SUITES, SYSTEM_PERSONAS};
use chrono::Utc;
use crossterm::event::{
    KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::{mpsc, watch};

pub const TAB_TITLES: [&str; 6] = [
    "1:Prompt",
    "2:Responses",
    "3:Waterfall",
    "4:Diff",
    "5:XY Graph",
    "6:Config",
];

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

    pub fn from_index(idx: usize) -> Option<Self> {
        match idx {
            0 => Some(ActiveTab::PromptSuites),
            1 => Some(ActiveTab::Responses),
            2 => Some(ActiveTab::Waterfall),
            3 => Some(ActiveTab::DiffCompare),
            4 => Some(ActiveTab::CapabilityGraph),
            5 => Some(ActiveTab::ConfigEditor),
            _ => None,
        }
    }

    pub fn next(self) -> Self {
        Self::from_index((self.index() + 1) % TAB_TITLES.len()).unwrap_or(ActiveTab::PromptSuites)
    }

    pub fn prev(self) -> Self {
        let idx = self.index();
        let prev = if idx == 0 { TAB_TITLES.len() - 1 } else { idx - 1 };
        Self::from_index(prev).unwrap_or(ActiveTab::PromptSuites)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFocus {
    Providers,
    Models,
    ModelFilter,
    Subgroups,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaterfallSortField {
    Order,
    Model,
    Status,
    Code,
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
            WaterfallSortField::Code => "Code",
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
            WaterfallSortField::Status => WaterfallSortField::Code,
            WaterfallSortField::Code => WaterfallSortField::Queue,
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
            WaterfallSortField::Queue => WaterfallSortField::Code,
            WaterfallSortField::Code => WaterfallSortField::Status,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UiLayoutZones {
    pub header_tabs_area: Rect,
    pub prompt_suites_area: Rect,
    pub prompt_suites_offset: usize,
    pub prompt_active_area: Rect,
    pub prompt_preview_area: Rect,
    pub responses_targets_area: Rect,
    pub responses_targets_offset: usize,
    pub responses_output_area: Rect,
    pub waterfall_table_area: Rect,
    pub waterfall_offset: usize,
    pub diff_area: Rect,
    pub config_settings_area: Rect,
    pub config_providers_area: Rect,
    pub config_providers_offset: usize,
    pub config_filter_area: Rect,
    pub config_models_area: Rect,
    pub config_models_offset: usize,
    pub config_subgroups_area: Rect,
    pub config_subgroups_offset: usize,
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
    pub selected_subgroup_idx: usize,
    pub model_filter: String,
    pub editing_subgroup_name: bool,
    pub subgroup_name_input: String,
    pub refreshing_providers: HashSet<String>,
    pub diff_left_idx: usize,
    pub diff_right_idx: usize,
    pub waterfall_sort: WaterfallSortField,
    pub waterfall_desc: bool,
    pub waterfall_selected_idx: usize,
    pub output_scroll: u16,
    pub layout_zones: UiLayoutZones,
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
            selected_subgroup_idx: 0,
            model_filter: String::new(),
            editing_subgroup_name: false,
            subgroup_name_input: String::new(),
            refreshing_providers: HashSet::new(),
            diff_left_idx: 0,
            diff_right_idx: 1,
            waterfall_sort: WaterfallSortField::Order,
            waterfall_desc: false,
            waterfall_selected_idx: 0,
            output_scroll: 0,
            layout_zones: UiLayoutZones::default(),
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
            ConfigFocus::ModelFilter => ConfigFocus::Subgroups,
            ConfigFocus::Subgroups => ConfigFocus::Providers,
        };
        if self.config_focus == ConfigFocus::Models {
            self.clamp_model_selection();
        }
    }

    pub fn subgroup_candidate_ids(&self) -> Vec<String> {
        let filtered_enabled: Vec<String> = self
            .filtered_target_indices()
            .into_iter()
            .filter_map(|idx| self.config.targets.get(idx))
            .filter(|t| t.enabled)
            .map(|t| t.id.clone())
            .collect();
        if !filtered_enabled.is_empty() {
            return filtered_enabled;
        }
        self.config
            .targets
            .iter()
            .filter(|t| t.enabled)
            .map(|t| t.id.clone())
            .collect()
    }

    pub fn start_save_subgroup(&mut self) {
        let ids = self.subgroup_candidate_ids();
        if ids.is_empty() {
            self.status_message =
                "Select/enable at least one target model before saving a subgroup.".to_string();
            return;
        }
        self.editing_subgroup_name = true;
        self.subgroup_name_input = self.model_filter.trim().to_string();
        let default_label = if self.subgroup_name_input.is_empty() {
            format!("subgroup-{}", self.config.subgroups.len() + 1)
        } else {
            self.subgroup_name_input.clone()
        };
        self.status_message = format!(
            "Saving {} model(s) — Enter subgroup name (Enter for \"{}\", Esc cancel)",
            ids.len(),
            default_label
        );
    }

    pub fn commit_save_subgroup(&mut self) {
        let ids = self.subgroup_candidate_ids();
        if ids.is_empty() {
            self.editing_subgroup_name = false;
            self.subgroup_name_input.clear();
            self.status_message = "No selected models to save into subgroup.".to_string();
            return;
        }
        let name = if !self.subgroup_name_input.trim().is_empty() {
            self.subgroup_name_input.trim().to_string()
        } else if !self.model_filter.trim().is_empty() {
            self.model_filter.trim().to_string()
        } else {
            format!("subgroup-{}", self.config.subgroups.len() + 1)
        };
        let filter_snapshot = self.model_filter.trim().to_string();
        let saved_id = self
            .config
            .save_subgroup(&name, &filter_snapshot, ids.clone())
            .id
            .clone();
        if let Some(pos) = self.config.subgroups.iter().position(|s| s.id == saved_id) {
            self.selected_subgroup_idx = pos;
        }
        self.editing_subgroup_name = false;
        self.subgroup_name_input.clear();
        self.config_focus = ConfigFocus::Subgroups;

        match self.config.save_with_backup(&self.config_path) {
            Ok(Some(bak)) => {
                self.config_dirty = false;
                self.status_message = format!(
                    "Saved subgroup \"{}\" ({} models) -> {} (backup: {})",
                    name,
                    ids.len(),
                    self.config_path.display(),
                    bak.display()
                );
            }
            Ok(None) => {
                self.config_dirty = false;
                self.status_message = format!(
                    "Saved subgroup \"{}\" ({} models) -> {}",
                    name,
                    ids.len(),
                    self.config_path.display()
                );
            }
            Err(err) => {
                self.config_dirty = true;
                self.status_message = format!(
                    "Subgroup \"{}\" staged ({} models), save error: {}",
                    name,
                    ids.len(),
                    err
                );
            }
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
            WaterfallSortField::Code => {
                list.sort_by(|a, b| {
                    let (_, la) = a.classify_status();
                    let (_, lb) = b.classify_status();
                    let ca = a.http_status.unwrap_or(999);
                    let cb = b.http_status.unwrap_or(999);
                    let ord = ca.cmp(&cb).then_with(|| la.cmp(&lb));
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
                            match self.config.save_with_backup(&self.config_path) {
                                Ok(bak) => {
                                    self.config_dirty = false;
                                    let bak_note = bak
                                        .map(|b| format!(" (backup: {})", b.display()))
                                        .unwrap_or_default();
                                    self.status_message = format!(
                                        "Refreshed {}: {} models (+{} provider, +{} targets) -> saved {}{}",
                                        provider_name,
                                        discovered_len,
                                        added_p,
                                        added_t,
                                        self.config_path.display(),
                                        bak_note
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
            ConfigFocus::Subgroups => self
                .config
                .subgroups
                .get(self.selected_subgroup_idx)
                .and_then(|sg| sg.target_ids.first())
                .and_then(|tid| self.config.targets.iter().find(|t| &t.id == tid))
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
        match self.config.save_with_backup(&self.config_path) {
            Ok(Some(bak)) => {
                self.config_dirty = false;
                self.status_message = format!(
                    "Saved config to {} (backup: {})",
                    self.config_path.display(),
                    bak.display()
                );
            }
            Ok(None) => {
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

        if self.editing_subgroup_name {
            match key.code {
                KeyCode::Esc => {
                    self.editing_subgroup_name = false;
                    self.subgroup_name_input.clear();
                    self.status_message = "Subgroup save cancelled.".to_string();
                }
                KeyCode::Enter => {
                    self.commit_save_subgroup();
                }
                KeyCode::Backspace => {
                    self.subgroup_name_input.pop();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.subgroup_name_input.clear();
                }
                KeyCode::Char(c) => {
                    self.subgroup_name_input.push(c);
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
                KeyCode::Char('g') | KeyCode::Char('s')
                    if key.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    self.start_save_subgroup();
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
            KeyCode::Char('z') => self.load_ping_probe(),
            KeyCode::Char('g') if self.active_tab == ActiveTab::PromptSuites => {
                self.load_ping_probe();
            }
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
            KeyCode::Enter
                if self.active_tab == ActiveTab::ConfigEditor
                    && self.config_focus == ConfigFocus::Subgroups =>
            {
                self.solo_selected_subgroup();
            }
            KeyCode::Enter | KeyCode::Char(' ') => self.activate_selected(),
            KeyCode::Char('+') | KeyCode::Char('=') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.concurrency = (self.config.execution.concurrency + 1).min(100);
                self.config_dirty = true;
            }
            KeyCode::Char('E') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.endpoint_type = self.config.execution.endpoint_type.next();
                self.config_dirty = true;
                self.status_message = format!(
                    "Endpoint Type: {}",
                    self.config.execution.endpoint_type.label()
                );
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
            KeyCode::Char('g') if self.active_tab == ActiveTab::ConfigEditor => {
                self.start_save_subgroup();
            }
            KeyCode::Delete | KeyCode::Backspace
                if self.active_tab == ActiveTab::ConfigEditor
                    && self.config_focus == ConfigFocus::Subgroups =>
            {
                if let Some(sg) = self.config.subgroups.get(self.selected_subgroup_idx).cloned() {
                    if let Some(removed) = self.config.delete_subgroup(&sg.id) {
                        self.config_dirty = true;
                        let len = self.config.subgroups.len();
                        if len == 0 {
                            self.selected_subgroup_idx = 0;
                        } else if self.selected_subgroup_idx >= len {
                            self.selected_subgroup_idx = len - 1;
                        }
                        self.status_message = format!("Deleted subgroup \"{}\"", removed.name);
                    }
                }
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
                ConfigFocus::Subgroups => {
                    self.selected_subgroup_idx = self.selected_subgroup_idx.saturating_sub(1);
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
                ConfigFocus::Subgroups => {
                    if self.selected_subgroup_idx + 1 < self.config.subgroups.len() {
                        self.selected_subgroup_idx += 1;
                    }
                }
            },
            _ => {}
        }
    }

    fn load_ping_probe(&mut self) {
        self.prompt = PING_PROBE_PROMPT.to_string();
        self.run_title = "Ping / Model Liveness Check".to_string();
        if let Some(idx) = PROMPT_SUITES.iter().position(|s| s.id == "ping-01") {
            self.selected_suite_idx = idx;
        }
        self.status_message =
            "Loaded Ping probe prompt (press 'r' to test all enabled models)".to_string();
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
                ConfigFocus::Subgroups => {
                    if let Some(sg) = self.config.subgroups.get(self.selected_subgroup_idx).cloned() {
                        if let Some((name, filter, next_state, affected)) =
                            self.config.toggle_subgroup_targets(&sg.id)
                        {
                            self.model_filter = filter;
                            self.selected_config_idx = 0;
                            self.config_dirty = true;
                            self.status_message = if next_state {
                                format!("Enabled subgroup \"{}\" ({} model(s))", name, affected)
                            } else {
                                format!("Disabled subgroup \"{}\" ({} model(s))", name, affected)
                            };
                        }
                    }
                }
            },
            _ => {}
        }
    }

    fn solo_selected_subgroup(&mut self) {
        if let Some(sg) = self.config.subgroups.get(self.selected_subgroup_idx).cloned() {
            if let Some((name, filter, active)) = self.config.solo_subgroup_targets(&sg.id) {
                self.model_filter = filter;
                self.selected_config_idx = 0;
                self.config_dirty = true;
                self.status_message = format!(
                    "Activated subgroup \"{}\" ({} model(s), filter: \"{}\")",
                    name, active, self.model_filter
                );
            }
        }
    }

    fn inner_list_row(area: Rect, col: u16, row: u16, offset: usize) -> Option<usize> {
        if area.width <= 2 || area.height <= 2 {
            return None;
        }
        let inner_x_end = area.x.saturating_add(area.width - 1);
        let inner_y_end = area.y.saturating_add(area.height - 1);
        if col > area.x && col < inner_x_end && row > area.y && row < inner_y_end {
            Some(offset.saturating_add((row - (area.y + 1)) as usize))
        } else {
            None
        }
    }

    pub fn handle_mouse(&mut self, mouse: MouseEvent) {
        let col = mouse.column;
        let row = mouse.row;
        let pos = Position { x: col, y: row };

        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if self.editing_prompt
                    && (self.active_tab != ActiveTab::PromptSuites
                        || !self.layout_zones.prompt_active_area.contains(pos))
                {
                    self.editing_prompt = false;
                    self.status_message = "Prompt edit saved.".to_string();
                }

                if self.editing_subgroup_name
                    && !self.layout_zones.config_subgroups_area.contains(pos)
                {
                    self.editing_subgroup_name = false;
                    self.subgroup_name_input.clear();
                    self.status_message = "Subgroup save cancelled.".to_string();
                }

                if self.layout_zones.header_tabs_area.contains(pos) {
                    let area = self.layout_zones.header_tabs_area;
                    let mut cur_x = area.x.saturating_add(1);
                    for (idx, title) in TAB_TITLES.iter().enumerate() {
                        let tab_w = title.len() as u16 + 2;
                        let divider_w = if idx + 1 < TAB_TITLES.len() { 1 } else { 0 };
                        if col >= cur_x && col < cur_x.saturating_add(tab_w + divider_w) {
                            if let Some(tab) = ActiveTab::from_index(idx) {
                                self.active_tab = tab;
                            }
                            return;
                        }
                        cur_x = cur_x.saturating_add(tab_w + divider_w);
                    }
                    return;
                }

                match self.active_tab {
                    ActiveTab::PromptSuites => {
                        if let Some(idx) = Self::inner_list_row(
                            self.layout_zones.prompt_suites_area,
                            col,
                            row,
                            self.layout_zones.prompt_suites_offset,
                        ) {
                            if idx < PROMPT_SUITES.len() {
                                if self.selected_suite_idx == idx {
                                    self.activate_selected();
                                } else {
                                    self.selected_suite_idx = idx;
                                    if let Some(item) = PROMPT_SUITES.get(idx) {
                                        self.status_message = format!(
                                            "Previewing [{}] {} (click again or Enter to load)",
                                            item.id, item.title
                                        );
                                    }
                                }
                            }
                        } else if self.layout_zones.prompt_active_area.contains(pos) {
                            self.editing_prompt = true;
                            self.status_message =
                                "Editing prompt (press Esc or click outside when done)"
                                    .to_string();
                        } else if self.layout_zones.prompt_preview_area.contains(pos) {
                            self.activate_selected();
                        }
                    }
                    ActiveTab::Responses => {
                        if let Some(idx) = Self::inner_list_row(
                            self.layout_zones.responses_targets_area,
                            col,
                            row,
                            self.layout_zones.responses_targets_offset,
                        ) {
                            let len = self.ordered_results().len();
                            if idx < len {
                                self.selected_result_idx = idx;
                                self.output_scroll = 0;
                            }
                        }
                    }
                    ActiveTab::Waterfall => {
                        let area = self.layout_zones.waterfall_table_area;
                        if area.contains(pos)
                            && area.width > 2
                            && area.height > 3
                            && col > area.x
                            && col < area.x.saturating_add(area.width - 1)
                        {
                            if row == area.y + 1 {
                                const WATERFALL_COLS: [(u16, WaterfallSortField); 9] = [
                                    (20, WaterfallSortField::Model),
                                    (9, WaterfallSortField::Status),
                                    (13, WaterfallSortField::Code),
                                    (9, WaterfallSortField::Queue),
                                    (9, WaterfallSortField::Request),
                                    (9, WaterfallSortField::Ttfb),
                                    (10, WaterfallSortField::Download),
                                    (10, WaterfallSortField::Total),
                                    (9, WaterfallSortField::Speed),
                                ];
                                let mut x = area.x + 1;
                                let mut chosen = WaterfallSortField::Order;
                                for (w, field) in WATERFALL_COLS {
                                    if col >= x && col < x.saturating_add(w + 1) {
                                        chosen = field;
                                        break;
                                    }
                                    x = x.saturating_add(w + 1);
                                }
                                if self.waterfall_sort == chosen {
                                    self.waterfall_desc = !self.waterfall_desc;
                                } else {
                                    self.waterfall_sort = chosen;
                                    self.waterfall_desc = chosen.default_desc();
                                }
                                self.status_message = format!(
                                    "Waterfall sort: {} ({})",
                                    self.waterfall_sort.label(),
                                    if self.waterfall_desc { "desc" } else { "asc" }
                                );
                            } else if row >= area.y + 2
                                && row < area.y.saturating_add(area.height - 1)
                            {
                                let idx = self.layout_zones.waterfall_offset
                                    + (row - (area.y + 2)) as usize;
                                if idx < self.ordered_results().len() {
                                    self.waterfall_selected_idx = idx;
                                }
                            }
                        }
                    }
                    ActiveTab::DiffCompare => {
                        if self.layout_zones.diff_area.contains(pos) {
                            let len = self.ordered_results().len().max(1);
                            let mid_x = self.layout_zones.diff_area.x
                                + self.layout_zones.diff_area.width / 2;
                            if col < mid_x {
                                self.diff_left_idx = (self.diff_left_idx + 1) % len;
                            } else {
                                self.diff_right_idx = (self.diff_right_idx + 1) % len;
                            }
                        }
                    }
                    ActiveTab::ConfigEditor => {
                        if self.layout_zones.config_settings_area.contains(pos) {
                            let area = self.layout_zones.config_settings_area;
                            if row > area.y && row < area.y.saturating_add(area.height - 1) {
                                let rel_row = row - (area.y + 1);
                                match rel_row {
                                    2 => {
                                        self.config.execution.mode = match self.config.execution.mode {
                                            ExecutionMode::Parallel => ExecutionMode::Sequential,
                                            ExecutionMode::Sequential => ExecutionMode::Parallel,
                                        };
                                        self.config_dirty = true;
                                    }
                                    3 => {
                                        self.config.execution.stream = !self.config.execution.stream;
                                        self.config_dirty = true;
                                    }
                                    5 => {
                                        if col < area.x + area.width / 2 {
                                            self.config.system_prompt.enabled =
                                                !self.config.system_prompt.enabled;
                                            self.config_dirty = true;
                                        } else {
                                            let cur_idx = self
                                                .config
                                                .system_prompt
                                                .persona
                                                .as_deref()
                                                .and_then(|id| {
                                                    SYSTEM_PERSONAS.iter().position(|p| p.id == id)
                                                })
                                                .unwrap_or(0);
                                            let next = &SYSTEM_PERSONAS
                                                [(cur_idx + 1) % SYSTEM_PERSONAS.len()];
                                            self.config.system_prompt.persona =
                                                Some(next.id.to_string());
                                            self.config.system_prompt.enabled = true;
                                            self.config_dirty = true;
                                            self.status_message =
                                                format!("Persona: {}", next.name);
                                        }
                                    }
                                    6 => {
                                        self.config.ui.theme = self.config.ui.theme.next();
                                        self.config_dirty = true;
                                        self.status_message =
                                            format!("Theme: {}", self.config.ui.theme.label());
                                    }
                                    7 => {
                                        self.config.execution.endpoint_type =
                                            self.config.execution.endpoint_type.next();
                                        self.config_dirty = true;
                                        self.status_message = format!(
                                            "Endpoint Type: {}",
                                            self.config.execution.endpoint_type.label()
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        } else if self.layout_zones.config_providers_area.contains(pos) {
                            let was_focused = self.config_focus == ConfigFocus::Providers;
                            self.config_focus = ConfigFocus::Providers;
                            if let Some(idx) = Self::inner_list_row(
                                self.layout_zones.config_providers_area,
                                col,
                                row,
                                self.layout_zones.config_providers_offset,
                            ) {
                                if idx < self.config.providers.len() {
                                    let was_selected =
                                        was_focused && self.selected_provider_idx == idx;
                                    let clicked_checkbox = col
                                        <= self.layout_zones.config_providers_area.x.saturating_add(6);
                                    self.selected_provider_idx = idx;
                                    if was_selected || clicked_checkbox {
                                        self.activate_selected();
                                    }
                                }
                            }
                        } else if self.layout_zones.config_filter_area.contains(pos) {
                            self.config_focus = ConfigFocus::ModelFilter;
                            self.status_message =
                                "Filtering models (type query, Enter/↓ for list, Esc clear)"
                                    .to_string();
                        } else if self.layout_zones.config_models_area.contains(pos) {
                            let was_focused = self.config_focus == ConfigFocus::Models;
                            self.config_focus = ConfigFocus::Models;
                            if let Some(idx) = Self::inner_list_row(
                                self.layout_zones.config_models_area,
                                col,
                                row,
                                self.layout_zones.config_models_offset,
                            ) {
                                let filtered_len = self.filtered_target_indices().len();
                                if idx < filtered_len {
                                    let was_selected =
                                        was_focused && self.selected_config_idx == idx;
                                    let clicked_checkbox = col
                                        <= self.layout_zones.config_models_area.x.saturating_add(6);
                                    self.selected_config_idx = idx;
                                    if was_selected || clicked_checkbox {
                                        self.activate_selected();
                                    }
                                }
                            } else {
                                self.clamp_model_selection();
                            }
                        } else if self.layout_zones.config_subgroups_area.contains(pos) {
                            let was_focused = self.config_focus == ConfigFocus::Subgroups;
                            self.config_focus = ConfigFocus::Subgroups;
                            if let Some(idx) = Self::inner_list_row(
                                self.layout_zones.config_subgroups_area,
                                col,
                                row,
                                self.layout_zones.config_subgroups_offset,
                            ) {
                                if idx < self.config.subgroups.len() {
                                    let was_selected =
                                        was_focused && self.selected_subgroup_idx == idx;
                                    let clicked_checkbox = col
                                        <= self.layout_zones.config_subgroups_area.x.saturating_add(6);
                                    self.selected_subgroup_idx = idx;
                                    if clicked_checkbox {
                                        self.activate_selected();
                                    } else if was_selected {
                                        self.solo_selected_subgroup();
                                    } else if let Some(sg) = self.config.subgroups.get(idx) {
                                        self.status_message = format!(
                                            "Selected subgroup \"{}\" (click [ ] to toggle, click again to solo, Del to remove)",
                                            sg.name
                                        );
                                    }
                                }
                            }
                        }
                    }
                    ActiveTab::CapabilityGraph => {}
                }
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let scroll_up = matches!(mouse.kind, MouseEventKind::ScrollUp);
                if self.layout_zones.header_tabs_area.contains(pos) {
                    self.active_tab = if scroll_up {
                        self.active_tab.prev()
                    } else {
                        self.active_tab.next()
                    };
                    return;
                }

                match self.active_tab {
                    ActiveTab::Responses
                        if self.layout_zones.responses_output_area.contains(pos) =>
                    {
                        if scroll_up {
                            self.output_scroll = self.output_scroll.saturating_sub(3);
                        } else {
                            self.output_scroll = self.output_scroll.saturating_add(3);
                        }
                    }
                    ActiveTab::ConfigEditor => {
                        if self.layout_zones.config_providers_area.contains(pos) {
                            self.config_focus = ConfigFocus::Providers;
                        } else if self.layout_zones.config_models_area.contains(pos) {
                            self.config_focus = ConfigFocus::Models;
                            self.clamp_model_selection();
                        } else if self.layout_zones.config_subgroups_area.contains(pos) {
                            self.config_focus = ConfigFocus::Subgroups;
                        }
                        if scroll_up {
                            self.navigate_up();
                        } else {
                            self.navigate_down();
                        }
                    }
                    _ => {
                        if scroll_up {
                            self.navigate_up();
                        } else {
                            self.navigate_down();
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn test_app() -> AppState {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = AppState::new(
            BenchConfig::default(),
            PathBuf::from("/tmp/benchforge-mouse-test.toml"),
            true,
            tx,
        );
        app.layout_zones = UiLayoutZones {
            header_tabs_area: Rect::new(0, 0, 100, 3),
            prompt_suites_area: Rect::new(0, 3, 45, 20),
            prompt_suites_offset: 0,
            prompt_active_area: Rect::new(45, 3, 55, 10),
            prompt_preview_area: Rect::new(45, 13, 55, 10),
            responses_targets_area: Rect::new(0, 3, 32, 20),
            responses_targets_offset: 0,
            responses_output_area: Rect::new(32, 3, 68, 20),
            waterfall_table_area: Rect::new(0, 3, 120, 20),
            waterfall_offset: 0,
            diff_area: Rect::new(0, 3, 100, 20),
            config_settings_area: Rect::new(0, 3, 48, 25),
            config_providers_area: Rect::new(48, 3, 52, 7),
            config_providers_offset: 0,
            config_filter_area: Rect::new(48, 10, 52, 3),
            config_models_area: Rect::new(48, 13, 52, 9),
            config_models_offset: 0,
            config_subgroups_area: Rect::new(48, 22, 52, 6),
            config_subgroups_offset: 0,
        };
        app
    }

    fn left_click(col: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: col,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    #[test]
    fn mouse_click_switches_header_tabs() {
        let mut app = test_app();
        // Tab 0 (" 1:Prompt ") starts at x=1, width=10 (1..11), divider at 11 -> Tab 1 starts at 12, Tab 5 at higher x.
        app.handle_mouse(left_click(13, 1));
        assert_eq!(app.active_tab, ActiveTab::Responses);

        // Compute exact x of "6:Config" tab dynamically
        let mut x = 1u16;
        for title in &TAB_TITLES[..5] {
            x += title.len() as u16 + 2 + 1;
        }
        app.handle_mouse(left_click(x + 2, 1));
        assert_eq!(app.active_tab, ActiveTab::ConfigEditor);
    }

    #[test]
    fn mouse_scroll_and_click_in_responses_and_waterfall() {
        let mut app = test_app();
        app.active_tab = ActiveTab::Responses;
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 50,
            row: 10,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.output_scroll, 3);

        app.active_tab = ActiveTab::Waterfall;
        // Click Code column header at row = area.y + 1 = 4, col = 1 + 20+1 + 9+1 + 3 = 35
        app.handle_mouse(left_click(35, 4));
        assert_eq!(app.waterfall_sort, WaterfallSortField::Code);
        assert!(!app.waterfall_desc);

        // Click TTFB column header at row = 4, col = 1 + 20+1 + 9+1 + 13+1 + 9+1 + 9+1 + 2 = 67
        app.handle_mouse(left_click(67, 4));
        assert_eq!(app.waterfall_sort, WaterfallSortField::Ttfb);
        assert!(!app.waterfall_desc);

        // Click same column header again flips desc
        app.handle_mouse(left_click(67, 4));
        assert_eq!(app.waterfall_sort, WaterfallSortField::Ttfb);
        assert!(app.waterfall_desc);

        // Quick Ping loader sets dummy liveness prompt
        app.load_ping_probe();
        assert!(app.prompt.contains("pong"));
    }

    #[test]
    fn mouse_click_focuses_and_toggles_config_panes() {
        let mut app = test_app();
        app.active_tab = ActiveTab::ConfigEditor;

        // Click Model Filter textbox at (55, 11)
        app.handle_mouse(left_click(55, 11));
        assert_eq!(app.config_focus, ConfigFocus::ModelFilter);

        // Click checkbox of first model row inside config_models_area (48, 13 -> inner row 14, col 51)
        let before_enabled = app.config.targets[0].enabled;
        app.handle_mouse(left_click(51, 14));
        assert_eq!(app.config_focus, ConfigFocus::Models);
        assert_eq!(app.selected_config_idx, 0);
        assert_eq!(app.config.targets[0].enabled, !before_enabled);
    }
}


use crate::config::{BenchConfig, CustomSendParam, ExecutionMode, TargetConfig, ThemeId};
use crate::engine::{
    spawn_benchmark_batch, spawn_chat_turn, spawn_refresh_provider_models, ChatTurnMessage,
    EngineEvent, ModelRunResult, RunStatus,
};
use crate::export::{
    export_bundle, load_history, load_latest_export, push_run_supabase, save_run_to_history,
    BenchmarkRunRecord,
};
use crate::suites::{PING_PROBE_PROMPT, PROMPT_SUITES, SYSTEM_PERSONAS};
use chrono::Utc;
use crossterm::event::{
    KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::{mpsc, watch};

pub const TAB_TITLES: [&str; 7] = [
    "1:Prompt",
    "2:Responses",
    "3:Waterfall",
    "4:Diff",
    "5:XY Graph",
    "6:Config",
    "7:Chat",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveTab {
    PromptSuites,
    Responses,
    Waterfall,
    DiffCompare,
    CapabilityGraph,
    ConfigEditor,
    Chat,
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
            ActiveTab::Chat => 6,
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
            6 => Some(ActiveTab::Chat),
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
pub enum ChatFocus {
    Params,
    Messages,
    Composer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatConfigRow {
    Builtin(ChatParamField),
    Custom(usize),
    AddParam,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatParamField {
    TargetModel,
    ProviderName,
    BaseUrl,
    ApiKeyEnv,
    ApiKeyInline,
    CustomHeaders,
    EndpointType,
    CustomEndpoint,
    Stream,
    TimeoutSec,
    Temperature,
    TopP,
    MaxTokens,
    Seed,
    TtsVoice,
    SystemPromptEnabled,
    SystemPersona,
    SystemPromptContent,
    TargetSystemOverride,
    EndpointFilesCount,
    ExecutionMode,
    Concurrency,
    RandomizeOrder,
}

pub const CHAT_PARAM_FIELDS: [ChatParamField; 23] = [
    ChatParamField::TargetModel,
    ChatParamField::ProviderName,
    ChatParamField::BaseUrl,
    ChatParamField::ApiKeyEnv,
    ChatParamField::ApiKeyInline,
    ChatParamField::CustomHeaders,
    ChatParamField::EndpointType,
    ChatParamField::CustomEndpoint,
    ChatParamField::Stream,
    ChatParamField::TimeoutSec,
    ChatParamField::Temperature,
    ChatParamField::TopP,
    ChatParamField::MaxTokens,
    ChatParamField::Seed,
    ChatParamField::TtsVoice,
    ChatParamField::SystemPromptEnabled,
    ChatParamField::SystemPersona,
    ChatParamField::SystemPromptContent,
    ChatParamField::TargetSystemOverride,
    ChatParamField::EndpointFilesCount,
    ChatParamField::ExecutionMode,
    ChatParamField::Concurrency,
    ChatParamField::RandomizeOrder,
];

impl ChatParamField {
    pub fn label(self) -> &'static str {
        match self {
            ChatParamField::TargetModel => "Target Model",
            ChatParamField::ProviderName => "Provider",
            ChatParamField::BaseUrl => "Base URL",
            ChatParamField::ApiKeyEnv => "API Key Env",
            ChatParamField::ApiKeyInline => "API Key (Inline)",
            ChatParamField::CustomHeaders => "Custom Headers",
            ChatParamField::EndpointType => "Endpoint Type",
            ChatParamField::CustomEndpoint => "Custom Endpoint",
            ChatParamField::Stream => "SSE Stream",
            ChatParamField::TimeoutSec => "Timeout (sec)",
            ChatParamField::Temperature => "Temperature",
            ChatParamField::TopP => "Top P",
            ChatParamField::MaxTokens => "Max Tokens",
            ChatParamField::Seed => "Seed",
            ChatParamField::TtsVoice => "TTS Voice",
            ChatParamField::SystemPromptEnabled => "System Layer On",
            ChatParamField::SystemPersona => "System Persona",
            ChatParamField::SystemPromptContent => "System Prompt",
            ChatParamField::TargetSystemOverride => "Target Sys Override",
            ChatParamField::EndpointFilesCount => "Endpoint Files",
            ChatParamField::ExecutionMode => "Exec Mode",
            ChatParamField::Concurrency => "Threads",
            ChatParamField::RandomizeOrder => "Random Order",
        }
    }

    pub fn is_toggle_or_cycle(self) -> bool {
        matches!(
            self,
            ChatParamField::TargetModel
                | ChatParamField::ProviderName
                | ChatParamField::EndpointType
                | ChatParamField::Stream
                | ChatParamField::SystemPromptEnabled
                | ChatParamField::SystemPersona
                | ChatParamField::EndpointFilesCount
                | ChatParamField::ExecutionMode
                | ChatParamField::RandomizeOrder
        )
    }

    pub fn hint(self) -> &'static str {
        match self {
            ChatParamField::TargetModel => "Enter/←/→ cycles target model for sending Chat turns",
            ChatParamField::ProviderName => "Enter/←/→ switches provider & its first model target",
            ChatParamField::BaseUrl => "Enter/e to edit provider Base URL (e.g. https://api.openai.com/v1)",
            ChatParamField::ApiKeyEnv => "Enter/e to edit environment variable name holding API key",
            ChatParamField::ApiKeyInline => "Enter/e to edit inline API key (masked in list)",
            ChatParamField::CustomHeaders => "Enter/e to edit 'Key: Value; Key2: Value2' custom headers",
            ChatParamField::EndpointType => "Enter/←/→ cycles /v1/chat/completions, /v1/responses, audio, embeddings, custom",
            ChatParamField::CustomEndpoint => "Enter/e to edit custom endpoint path or full URL",
            ChatParamField::Stream => "Enter/Space/←/→ toggles SSE streaming",
            ChatParamField::TimeoutSec => "←/→ (+/-10s) or Enter/e to type timeout (5..600 sec)",
            ChatParamField::Temperature => "←/→ (+/-0.05) or Enter/e to type temperature (0.0..2.0)",
            ChatParamField::TopP => "←/→ (+/-0.05) or Enter/e to type top_p (0.0..1.0)",
            ChatParamField::MaxTokens => "←/→ (+/-128) or Enter/e to type max_tokens (0 = omit)",
            ChatParamField::Seed => "←/→ or Enter/e to type seed integer (empty = none)",
            ChatParamField::TtsVoice => "Enter/e to edit TTS voice (e.g. alloy, nova, echo)",
            ChatParamField::SystemPromptEnabled => "Enter/Space/←/→ toggles System Prompt Layer",
            ChatParamField::SystemPersona => "Enter/←/→ cycles built-in System Persona (or none)",
            ChatParamField::SystemPromptContent => "Enter/e to edit custom System Prompt text",
            ChatParamField::TargetSystemOverride => "Enter/e to edit per-target system_prompt_override (empty clears)",
            ChatParamField::EndpointFilesCount => "Enter/Space toggles attached [[endpoint_files]] active state",
            ChatParamField::ExecutionMode => "Enter/Space/←/→ switches Parallel / Sequential",
            ChatParamField::Concurrency => "←/→ (+/-1) or Enter/e to type worker threads (1..100)",
            ChatParamField::RandomizeOrder => "Enter/Space/←/→ toggles random target execution order",
        }
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
    pub chat_params_area: Rect,
    pub chat_params_offset: usize,
    pub chat_messages_area: Rect,
    pub chat_composer_area: Rect,
}

pub struct AppState {
    pub config: BenchConfig,
    pub config_path: PathBuf,
    pub config_dirty: bool,
    pub active_tab: ActiveTab,
    pub config_focus: ConfigFocus,
    pub config_settings_scroll: u16,
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
    pub chat_focus: ChatFocus,
    pub chat_target_id: String,
    pub chat_selected_param_idx: usize,
    pub chat_editing_param: bool,
    pub chat_adding_param: bool,
    pub chat_param_input: String,
    pub chat_editing_composer: bool,
    pub chat_input: String,
    pub chat_messages: Vec<ChatTurnMessage>,
    pub chat_scroll: u16,
    pub chat_running: bool,
    pub chat_active_assistant_idx: Option<usize>,
    pub chat_last_result: Option<ModelRunResult>,
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
        let default_chat_target = config
            .enabled_targets()
            .first()
            .or_else(|| config.targets.first())
            .map(|t| t.id.clone())
            .unwrap_or_default();
        let initial_prompt = first_suite.prompt.to_string();
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
            config_settings_scroll: 0,
            editing_prompt: false,
            prompt: initial_prompt.clone(),
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
            chat_focus: ChatFocus::Params,
            chat_target_id: default_chat_target,
            chat_selected_param_idx: 0,
            chat_editing_param: false,
            chat_adding_param: false,
            chat_param_input: String::new(),
            chat_editing_composer: false,
            chat_input: String::new(),
            chat_messages: vec![ChatTurnMessage {
                role: "user".to_string(),
                content: initial_prompt,
            }],
            chat_scroll: 0,
            chat_running: false,
            chat_active_assistant_idx: None,
            chat_last_result: None,
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
        let mut seen = HashSet::new();
        for t in &self.config.targets {
            if !t.enabled && !self.results.contains_key(&t.id) {
                continue;
            }
            seen.insert(t.id.clone());
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
        let mut extra: Vec<&ModelRunResult> = self
            .results
            .values()
            .filter(|r| !seen.contains(&r.target_id))
            .collect();
        extra.sort_by(|a, b| a.model_name.cmp(&b.model_name));
        for res in extra {
            list.push(res.clone());
        }
        list
    }

    pub fn shuffle_targets_in_place(targets: &mut [TargetConfig], seed: u64) {
        if targets.len() <= 1 {
            return;
        }
        let mut state = seed ^ 0x9E37_79B9_7F4A_7C15;
        for i in (1..targets.len()).rev() {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            let j = (z as usize) % (i + 1);
            targets.swap(i, j);
        }
    }

    pub fn start_run(&mut self, retry_failed_only: bool) {
        if self.is_running {
            return;
        }
        let mut targets: Vec<_> = self
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

        if self.config.execution.randomize_order {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(1);
            let target_len_seed = targets.len() as u64;
            Self::shuffle_targets_in_place(&mut targets, nanos ^ target_len_seed);
        }

        if !retry_failed_only {
            self.results.clear();
        }
        let (abort_tx, abort_rx) = watch::channel(false);
        self.abort_tx = Some(abort_tx);
        self.is_running = true;
        self.active_tab = ActiveTab::Responses;
        self.status_message = if self.config.execution.randomize_order {
            format!("Running {} target(s) [random order]...", targets.len())
        } else {
            format!("Running {} target(s)...", targets.len())
        };

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
            self.status_message = if self.chat_running {
                "Aborting active chat request...".to_string()
            } else {
                "Aborting active run...".to_string()
            };
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
            EngineEvent::ChatUpdate(res) => {
                let text = if !res.output.is_empty() {
                    if let Some(ref err) = res.error {
                        format!("{}\n\n[ERROR: {}]", res.output, err)
                    } else {
                        res.output.clone()
                    }
                } else if let Some(ref err) = res.error {
                    if let Some(ref adv) = res.advice {
                        format!("ERROR: {}\nADVICE: {}", err, adv)
                    } else {
                        format!("ERROR: {}", err)
                    }
                } else {
                    "...".to_string()
                };

                if let Some(idx) = self.chat_active_assistant_idx {
                    if let Some(msg) = self.chat_messages.get_mut(idx) {
                        msg.content = text;
                    }
                } else {
                    self.chat_messages.push(ChatTurnMessage {
                        role: "assistant".to_string(),
                        content: text,
                    });
                    self.chat_active_assistant_idx = Some(self.chat_messages.len() - 1);
                }
                self.chat_last_result = Some(res);
            }
            EngineEvent::ChatFinished => {
                self.chat_running = false;
                self.chat_active_assistant_idx = None;
                self.abort_tx = None;
                if let Some(ref res) = self.chat_last_result {
                    self.results.insert(res.target_id.clone(), res.clone());
                    self.status_message = format!(
                        "Chat reply from {} finished ({:.1} tok/s, {:.0} ms)",
                        res.model_name, res.tokens_per_sec, res.timing.total_ms
                    );
                } else {
                    self.status_message = "Chat turn finished.".to_string();
                }
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

    pub fn apply_imported_record(&mut self, record: BenchmarkRunRecord) {
        if !record.prompt.is_empty() {
            self.prompt = record.prompt.clone();
        }
        if !record.title.is_empty() {
            self.run_title = record.title.clone();
        }
        self.results.clear();
        let count = record.results.len();
        for res in &record.results {
            self.results.insert(res.target_id.clone(), res.clone());
        }
        self.selected_result_idx = 0;
        self.waterfall_selected_idx = 0;
        self.output_scroll = 0;
        if let Ok(updated) = save_run_to_history(record, self.config.ui.history_limit) {
            self.history = updated;
        }
        self.status_message = format!("Imported {} result(s) into workspace.", count);
    }

    #[cfg(test)]
    pub fn import_results_from_str(&mut self, raw: &str) -> Result<usize, String> {
        let record = crate::export::import_bundle_json(raw).map_err(|e| e.to_string())?;
        let count = record.results.len();
        self.apply_imported_record(record);
        Ok(count)
    }

    pub fn import_latest_results(&mut self) {
        let export_dir = PathBuf::from("exports");
        match load_latest_export(&export_dir) {
            Ok((path, record)) => {
                let count = record.results.len();
                self.apply_imported_record(record);
                self.status_message =
                    format!("Imported {} result(s) from {}", count, path.display());
            }
            Err(err) => {
                self.status_message = format!("Import JSON failed: {}", err);
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

        if self.active_tab == ActiveTab::Chat && self.chat_adding_param {
            match key.code {
                KeyCode::Esc => {
                    self.chat_adding_param = false;
                    self.chat_param_input.clear();
                    self.status_message = "Add custom param cancelled.".to_string();
                }
                KeyCode::Enter => {
                    self.commit_add_chat_param();
                }
                KeyCode::Backspace => {
                    self.chat_param_input.pop();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.chat_param_input.clear();
                }
                KeyCode::Char(c) => {
                    self.chat_param_input.push(c);
                }
                _ => {}
            }
            return;
        }

        if self.active_tab == ActiveTab::Chat && self.chat_editing_param {
            match key.code {
                KeyCode::Esc => {
                    self.chat_editing_param = false;
                    self.chat_param_input.clear();
                    self.status_message = "Parameter edit cancelled.".to_string();
                }
                KeyCode::Enter => {
                    self.commit_chat_param_edit();
                }
                KeyCode::Backspace => {
                    self.chat_param_input.pop();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.chat_param_input.clear();
                }
                KeyCode::Char(c) => {
                    self.chat_param_input.push(c);
                }
                _ => {}
            }
            return;
        }

        if self.active_tab == ActiveTab::Chat && self.chat_editing_composer {
            match key.code {
                KeyCode::Up if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    self.chat_scroll = self.chat_scroll.saturating_sub(3);
                }
                KeyCode::Down if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    self.chat_scroll = self.chat_scroll.saturating_add(3);
                }
                KeyCode::Esc => {
                    self.chat_editing_composer = false;
                    self.chat_focus = ChatFocus::Messages;
                    self.status_message = "Exited chat composer.".to_string();
                }
                KeyCode::Enter
                    if key.modifiers.contains(KeyModifiers::SHIFT)
                        || key.modifiers.contains(KeyModifiers::ALT) =>
                {
                    self.chat_input.push('\n');
                }
                KeyCode::Enter => {
                    self.send_chat_turn();
                }
                KeyCode::Backspace => {
                    self.chat_input.pop();
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.chat_input.clear();
                }
                KeyCode::Char(c) => {
                    self.chat_input.push(c);
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
            KeyCode::Char('7') => self.active_tab = ActiveTab::Chat,
            KeyCode::Char('t') => {
                self.config.ui.theme = self.config.ui.theme.next();
                self.config_dirty = true;
                self.status_message = format!("Theme: {}", self.config.ui.theme.label());
            }
            KeyCode::Char('r') if self.active_tab == ActiveTab::Chat => self.send_chat_turn(),
            KeyCode::Char('r') => self.start_run(false),
            KeyCode::Char('R') => self.start_run(true),
            KeyCode::Char('x') => self.abort_run(),
            KeyCode::Char('s') => self.save_config(),
            KeyCode::Char('e') if self.active_tab == ActiveTab::Chat => {
                self.chat_focus = ChatFocus::Params;
                self.begin_edit_chat_param();
            }
            KeyCode::Char('e') => self.export_results(),
            KeyCode::Char('L') => self.import_latest_results(),
            KeyCode::Char('z') => self.load_ping_probe(),
            KeyCode::Char('g') if self.active_tab == ActiveTab::PromptSuites => {
                self.load_ping_probe();
            }
            KeyCode::Char('i') if self.active_tab == ActiveTab::PromptSuites => {
                self.editing_prompt = true;
                self.status_message = "Editing prompt (press Esc when done)".to_string();
            }
            KeyCode::Char('i') if self.active_tab == ActiveTab::Chat => {
                self.chat_focus = ChatFocus::Composer;
                self.chat_editing_composer = true;
                self.status_message = "Chat composer active (Enter to send, Shift+Enter newline, Esc exit)".to_string();
            }
            KeyCode::Char('c') if self.active_tab == ActiveTab::Chat => {
                self.chat_messages.clear();
                if !self.prompt.trim().is_empty() {
                    self.chat_messages.push(ChatTurnMessage {
                        role: "user".to_string(),
                        content: self.prompt.clone(),
                    });
                }
                self.chat_last_result = None;
                self.chat_scroll = 0;
                self.status_message = "Reset chat conversation to active prompt.".to_string();
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
            KeyCode::BackTab if self.active_tab == ActiveTab::Chat => {
                self.cycle_chat_focus();
            }
            KeyCode::Tab
                if self.active_tab == ActiveTab::Chat
                    && key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                self.cycle_chat_focus();
            }
            KeyCode::Tab => {
                self.active_tab = self.active_tab.next();
            }
            KeyCode::Char('/') | KeyCode::Char('f')
                if self.active_tab == ActiveTab::ConfigEditor =>
            {
                self.config_focus = ConfigFocus::ModelFilter;
                self.status_message =
                    "Filtering models (type query, Enter/Down for list, Esc clear)".to_string();
            }
            KeyCode::Up
                if self.active_tab == ActiveTab::Responses
                    && key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                self.output_scroll = self.output_scroll.saturating_sub(3);
            }
            KeyCode::Down
                if self.active_tab == ActiveTab::Responses
                    && key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                self.output_scroll = self.output_scroll.saturating_add(3);
            }
            KeyCode::Up
                if self.active_tab == ActiveTab::Chat
                    && key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                self.chat_scroll = self.chat_scroll.saturating_sub(3);
            }
            KeyCode::Down
                if self.active_tab == ActiveTab::Chat
                    && key.modifiers.contains(KeyModifiers::SHIFT) =>
            {
                self.chat_scroll = self.chat_scroll.saturating_add(3);
            }
            KeyCode::PageDown if self.active_tab == ActiveTab::Chat => {
                let max_idx = self.chat_config_rows().len().saturating_sub(1);
                match self.chat_focus {
                    ChatFocus::Params => {
                        self.chat_selected_param_idx = (self.chat_selected_param_idx + 5).min(max_idx);
                    }
                    _ => {
                        self.chat_scroll = self.chat_scroll.saturating_add(6);
                    }
                }
            }
            KeyCode::PageUp if self.active_tab == ActiveTab::Chat => {
                match self.chat_focus {
                    ChatFocus::Params => {
                        self.chat_selected_param_idx = self.chat_selected_param_idx.saturating_sub(5);
                    }
                    _ => {
                        self.chat_scroll = self.chat_scroll.saturating_sub(6);
                    }
                }
            }
            KeyCode::Up | KeyCode::Char('k') => self.navigate_up(),
            KeyCode::Down | KeyCode::Char('j') => self.navigate_down(),
            KeyCode::Enter if self.active_tab == ActiveTab::PromptSuites => {
                self.open_chat_from_prompt();
            }
            KeyCode::Enter if self.active_tab == ActiveTab::Responses => {
                self.open_chat_from_selected_response();
            }
            KeyCode::Enter if self.active_tab == ActiveTab::Waterfall => {
                self.open_chat_from_waterfall();
            }
            KeyCode::Enter
                if self.active_tab == ActiveTab::ConfigEditor
                    && self.config_focus == ConfigFocus::Subgroups =>
            {
                self.solo_selected_subgroup();
            }
            KeyCode::Enter if self.active_tab == ActiveTab::Chat => {
                match self.chat_focus {
                    ChatFocus::Params => self.begin_edit_chat_param(),
                    ChatFocus::Messages => {
                        self.chat_focus = ChatFocus::Composer;
                        self.chat_editing_composer = true;
                        self.status_message = "Chat composer active (Enter to send, Esc exit)".to_string();
                    }
                    ChatFocus::Composer => self.send_chat_turn(),
                }
            }
            KeyCode::Char(' ') => self.activate_selected(),
            KeyCode::Char('a') | KeyCode::Char('A') | KeyCode::Char('+')
                if self.active_tab == ActiveTab::Chat && self.chat_focus == ChatFocus::Params =>
            {
                self.start_add_chat_param();
            }
            KeyCode::Delete | KeyCode::Backspace
                if self.active_tab == ActiveTab::Chat && self.chat_focus == ChatFocus::Params =>
            {
                self.remove_selected_custom_chat_param();
            }
            KeyCode::Left | KeyCode::Char('-') | KeyCode::Char('h')
                if self.active_tab == ActiveTab::Chat && self.chat_focus == ChatFocus::Params =>
            {
                self.step_chat_param(-1);
            }
            KeyCode::Right | KeyCode::Char('=') | KeyCode::Char('l')
                if self.active_tab == ActiveTab::Chat && self.chat_focus == ChatFocus::Params =>
            {
                self.step_chat_param(1);
            }
            KeyCode::Left | KeyCode::Char('h') if self.active_tab == ActiveTab::Chat => {
                self.chat_focus = ChatFocus::Params;
            }
            KeyCode::Right | KeyCode::Char('l') if self.active_tab == ActiveTab::Chat => {
                self.chat_focus = ChatFocus::Messages;
            }
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
                self.config.execution.mode = self.config.execution.mode.toggle();
                self.config_dirty = true;
            }
            KeyCode::Char('v') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.stream = !self.config.execution.stream;
                self.config_dirty = true;
            }
            KeyCode::Char('N') if self.active_tab == ActiveTab::ConfigEditor => {
                self.config.execution.randomize_order = !self.config.execution.randomize_order;
                self.config_dirty = true;
                self.status_message = format!(
                    "Random model order: {}",
                    self.config.execution.randomize_order
                );
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
            ActiveTab::Chat => match self.chat_focus {
                ChatFocus::Params => {
                    self.chat_selected_param_idx = self.chat_selected_param_idx.saturating_sub(1);
                }
                ChatFocus::Messages | ChatFocus::Composer => {
                    self.chat_scroll = self.chat_scroll.saturating_sub(2);
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
            ActiveTab::Chat => match self.chat_focus {
                ChatFocus::Params => {
                    let max_idx = self.chat_config_rows().len().saturating_sub(1);
                    if self.chat_selected_param_idx < max_idx {
                        self.chat_selected_param_idx += 1;
                    }
                }
                ChatFocus::Messages | ChatFocus::Composer => {
                    self.chat_scroll = self.chat_scroll.saturating_add(2);
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
                self.open_waterfall_selected_response();
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
            ActiveTab::Chat => {
                if self.chat_focus == ChatFocus::Params {
                    self.toggle_chat_row_activation();
                }
            }
            _ => {}
        }
    }

    pub fn open_waterfall_selected_response(&mut self) {
        let sorted = self.sorted_waterfall_results();
        if sorted.is_empty() {
            return;
        }
        let clamped_idx = self.waterfall_selected_idx.min(sorted.len() - 1);
        let chosen = &sorted[clamped_idx];
        let ordered = self.ordered_results();
        let response_idx = ordered
            .iter()
            .position(|r| r.target_id == chosen.target_id)
            .unwrap_or(0);
        self.selected_result_idx = response_idx;
        self.output_scroll = 0;
        self.active_tab = ActiveTab::Responses;
        self.status_message = format!(
            "Opened response for {} ({})",
            chosen.model_name, chosen.provider_name
        );
    }

    pub fn active_chat_target(&self) -> Option<&TargetConfig> {
        self.config
            .targets
            .iter()
            .find(|t| t.id == self.chat_target_id)
            .or_else(|| self.config.enabled_targets().into_iter().next())
            .or_else(|| self.config.targets.first())
    }

    fn cycle_chat_focus(&mut self) {
        self.chat_focus = match self.chat_focus {
            ChatFocus::Params => ChatFocus::Messages,
            ChatFocus::Messages => ChatFocus::Composer,
            ChatFocus::Composer => ChatFocus::Params,
        };
        self.chat_editing_composer = self.chat_focus == ChatFocus::Composer;
    }

    pub fn chat_config_rows(&self) -> Vec<ChatConfigRow> {
        let mut rows: Vec<ChatConfigRow> = CHAT_PARAM_FIELDS
            .iter()
            .copied()
            .map(ChatConfigRow::Builtin)
            .collect();
        for idx in 0..self.config.execution.extra_params.len() {
            rows.push(ChatConfigRow::Custom(idx));
        }
        rows.push(ChatConfigRow::AddParam);
        rows
    }

    pub fn selected_chat_row(&self) -> ChatConfigRow {
        let rows = self.chat_config_rows();
        let idx = self.chat_selected_param_idx.min(rows.len().saturating_sub(1));
        rows[idx]
    }

    pub fn is_chat_field_activated(&self, field: ChatParamField) -> Option<bool> {
        let act = &self.config.execution.active_params;
        match field {
            ChatParamField::CustomHeaders => Some(act.custom_headers),
            ChatParamField::CustomEndpoint => Some(act.custom_endpoint),
            ChatParamField::Stream => Some(act.stream && self.config.execution.stream),
            ChatParamField::Temperature => Some(act.temperature),
            ChatParamField::TopP => Some(act.top_p),
            ChatParamField::MaxTokens => Some(act.max_tokens),
            ChatParamField::Seed => Some(act.seed),
            ChatParamField::TtsVoice => Some(act.tts_voice),
            ChatParamField::SystemPromptEnabled => Some(self.config.system_prompt.enabled),
            ChatParamField::EndpointFilesCount => Some(act.endpoint_files),
            _ => None,
        }
    }

    pub fn toggle_chat_row_activation(&mut self) {
        match self.selected_chat_row() {
            ChatConfigRow::AddParam => self.start_add_chat_param(),
            ChatConfigRow::Custom(idx) => {
                if let Some(param) = self.config.execution.extra_params.get_mut(idx) {
                    param.enabled = !param.enabled;
                    let key = param.key.clone();
                    let active = param.enabled;
                    self.config_dirty = true;
                    self.status_message = format!(
                        "Custom param '{}' active: {}",
                        key,
                        if active { "ON [x]" } else { "OFF [ ]" }
                    );
                }
            }
            ChatConfigRow::Builtin(field) => {
                let act = &mut self.config.execution.active_params;
                let mut toggled = true;
                let new_state = match field {
                    ChatParamField::CustomHeaders => {
                        act.custom_headers = !act.custom_headers;
                        act.custom_headers
                    }
                    ChatParamField::CustomEndpoint => {
                        act.custom_endpoint = !act.custom_endpoint;
                        act.custom_endpoint
                    }
                    ChatParamField::Stream => {
                        let next = !(act.stream && self.config.execution.stream);
                        act.stream = next;
                        self.config.execution.stream = next;
                        next
                    }
                    ChatParamField::Temperature => {
                        act.temperature = !act.temperature;
                        act.temperature
                    }
                    ChatParamField::TopP => {
                        act.top_p = !act.top_p;
                        act.top_p
                    }
                    ChatParamField::MaxTokens => {
                        act.max_tokens = !act.max_tokens;
                        act.max_tokens
                    }
                    ChatParamField::Seed => {
                        act.seed = !act.seed;
                        act.seed
                    }
                    ChatParamField::TtsVoice => {
                        act.tts_voice = !act.tts_voice;
                        act.tts_voice
                    }
                    ChatParamField::SystemPromptEnabled => {
                        self.config.system_prompt.enabled = !self.config.system_prompt.enabled;
                        self.config.system_prompt.enabled
                    }
                    ChatParamField::EndpointFilesCount => {
                        act.endpoint_files = !act.endpoint_files;
                        act.endpoint_files
                    }
                    _ => {
                        toggled = false;
                        true
                    }
                };
                if toggled {
                    self.config_dirty = true;
                    self.status_message = format!(
                        "{} {}",
                        field.label(),
                        if new_state {
                            "activated [x] for sending"
                        } else {
                            "deactivated [ ] (omitted on send)"
                        }
                    );
                } else {
                    self.begin_edit_chat_param();
                }
            }
        }
    }

    pub fn start_add_chat_param(&mut self) {
        self.chat_editing_param = false;
        self.chat_adding_param = true;
        self.chat_param_input.clear();
        self.status_message =
            "Add Param: type key=value (e.g. presence_penalty=0.2), Enter Add, Esc Cancel"
                .to_string();
    }

    pub fn commit_add_chat_param(&mut self) {
        let raw = self.chat_param_input.trim().to_string();
        let (raw_key, raw_val) = if let Some((k, v)) = raw.split_once('=').or_else(|| raw.split_once(':')) {
            (k.trim(), v.trim())
        } else {
            (raw.as_str(), "true")
        };
        let key = if raw_key.is_empty() {
            format!("param_{}", self.config.execution.extra_params.len() + 1)
        } else {
            raw_key.to_string()
        };
        let value = if raw_val.is_empty() {
            "true".to_string()
        } else {
            raw_val.to_string()
        };
        self.config.execution.extra_params.push(CustomSendParam {
            key: key.clone(),
            value: value.clone(),
            enabled: true,
        });
        let new_row_idx = CHAT_PARAM_FIELDS.len() + self.config.execution.extra_params.len() - 1;
        self.chat_selected_param_idx = new_row_idx;
        self.chat_adding_param = false;
        self.chat_param_input.clear();
        self.config_dirty = true;
        self.status_message = format!("Added custom param: {} = {}", key, value);
    }

    pub fn remove_selected_custom_chat_param(&mut self) {
        if let ChatConfigRow::Custom(idx) = self.selected_chat_row() {
            if idx < self.config.execution.extra_params.len() {
                let removed = self.config.execution.extra_params.remove(idx);
                self.config_dirty = true;
                let max_idx = self.chat_config_rows().len().saturating_sub(1);
                if self.chat_selected_param_idx > max_idx {
                    self.chat_selected_param_idx = max_idx;
                }
                self.status_message = format!("Removed custom param '{}'", removed.key);
            }
        }
    }

    pub fn chat_param_display_value(&self, field: ChatParamField) -> String {
        let target_opt = self.active_chat_target();
        let provider_opt = target_opt.and_then(|t| self.config.find_provider(&t.provider_id));
        match field {
            ChatParamField::TargetModel => target_opt
                .map(|t| t.model.clone())
                .unwrap_or_else(|| "<none>".to_string()),
            ChatParamField::ProviderName => provider_opt
                .map(|p| format!("{} ({})", p.name, p.id))
                .unwrap_or_else(|| "<none>".to_string()),
            ChatParamField::BaseUrl => provider_opt
                .map(|p| p.base_url.clone())
                .unwrap_or_default(),
            ChatParamField::ApiKeyEnv => provider_opt
                .map(|p| {
                    if p.api_key_env.trim().is_empty() {
                        "<none>".to_string()
                    } else {
                        p.api_key_env.clone()
                    }
                })
                .unwrap_or_default(),
            ChatParamField::ApiKeyInline => provider_opt
                .map(|p| {
                    let k = p.api_key.trim();
                    if k.is_empty() {
                        "<empty>".to_string()
                    } else if k.len() <= 8 {
                        "********".to_string()
                    } else {
                        format!("{}...{}", &k[..4], &k[k.len() - 4..])
                    }
                })
                .unwrap_or_default(),
            ChatParamField::CustomHeaders => provider_opt
                .map(|p| {
                    if p.custom_headers.is_empty() {
                        "<none>".to_string()
                    } else {
                        let mut pairs: Vec<String> = p
                            .custom_headers
                            .iter()
                            .map(|(k, v)| format!("{}: {}", k, v))
                            .collect();
                        pairs.sort();
                        pairs.join("; ")
                    }
                })
                .unwrap_or_default(),
            ChatParamField::EndpointType => self.config.execution.endpoint_type.label().to_string(),
            ChatParamField::CustomEndpoint => {
                if self.config.execution.custom_endpoint.trim().is_empty() {
                    "<auto /chat/completions>".to_string()
                } else {
                    self.config.execution.custom_endpoint.clone()
                }
            }
            ChatParamField::Stream => self.config.execution.stream.to_string(),
            ChatParamField::TimeoutSec => format!("{}s", self.config.execution.timeout_sec),
            ChatParamField::Temperature => format!("{:.2}", self.config.execution.temperature),
            ChatParamField::TopP => format!("{:.2}", self.config.execution.top_p),
            ChatParamField::MaxTokens => self.config.execution.max_tokens.to_string(),
            ChatParamField::Seed => self
                .config
                .execution
                .seed
                .map(|s| s.to_string())
                .unwrap_or_else(|| "<none>".to_string()),
            ChatParamField::TtsVoice => self.config.execution.tts_voice.clone(),
            ChatParamField::SystemPromptEnabled => self.config.system_prompt.enabled.to_string(),
            ChatParamField::SystemPersona => self
                .config
                .system_prompt
                .persona
                .as_deref()
                .map(|id| match crate::suites::lookup_persona(id) {
                    Some(p) => format!("{} [{}]", p.name, p.category),
                    None => id.to_string(),
                })
                .unwrap_or_else(|| "<none>".to_string()),
            ChatParamField::SystemPromptContent => {
                if self.config.system_prompt.content.trim().is_empty() {
                    "<empty (uses persona if set)>".to_string()
                } else {
                    self.config.system_prompt.content.clone()
                }
            }
            ChatParamField::TargetSystemOverride => target_opt
                .and_then(|t| t.system_prompt_override.as_ref())
                .map(|s| s.clone())
                .unwrap_or_else(|| "<none>".to_string()),
            ChatParamField::EndpointFilesCount => format!(
                "{} active / {} total",
                self.config.matching_endpoint_files().len(),
                self.config.endpoint_files.len()
            ),
            ChatParamField::ExecutionMode => match self.config.execution.mode {
                ExecutionMode::Parallel => "Parallel".to_string(),
                ExecutionMode::Sequential => "Sequential".to_string(),
            },
            ChatParamField::Concurrency => format!("{}/100", self.config.execution.concurrency),
            ChatParamField::RandomizeOrder => self.config.execution.randomize_order.to_string(),
        }
    }

    fn chat_param_raw_edit_value(&self, field: ChatParamField) -> String {
        let target_opt = self.active_chat_target();
        let provider_opt = target_opt.and_then(|t| self.config.find_provider(&t.provider_id));
        match field {
            ChatParamField::BaseUrl => provider_opt.map(|p| p.base_url.clone()).unwrap_or_default(),
            ChatParamField::ApiKeyEnv => provider_opt.map(|p| p.api_key_env.clone()).unwrap_or_default(),
            ChatParamField::ApiKeyInline => provider_opt.map(|p| p.api_key.clone()).unwrap_or_default(),
            ChatParamField::CustomHeaders => provider_opt
                .map(|p| {
                    let mut pairs: Vec<String> = p
                        .custom_headers
                        .iter()
                        .map(|(k, v)| format!("{}: {}", k, v))
                        .collect();
                    pairs.sort();
                    pairs.join("; ")
                })
                .unwrap_or_default(),
            ChatParamField::CustomEndpoint => self.config.execution.custom_endpoint.clone(),
            ChatParamField::TimeoutSec => self.config.execution.timeout_sec.to_string(),
            ChatParamField::Temperature => format!("{:.2}", self.config.execution.temperature),
            ChatParamField::TopP => format!("{:.2}", self.config.execution.top_p),
            ChatParamField::MaxTokens => self.config.execution.max_tokens.to_string(),
            ChatParamField::Seed => self
                .config
                .execution
                .seed
                .map(|s| s.to_string())
                .unwrap_or_default(),
            ChatParamField::TtsVoice => self.config.execution.tts_voice.clone(),
            ChatParamField::SystemPromptContent => self.config.system_prompt.content.clone(),
            ChatParamField::TargetSystemOverride => target_opt
                .and_then(|t| t.system_prompt_override.clone())
                .unwrap_or_default(),
            ChatParamField::Concurrency => self.config.execution.concurrency.to_string(),
            _ => self.chat_param_display_value(field),
        }
    }

    pub fn begin_edit_chat_param(&mut self) {
        match self.selected_chat_row() {
            ChatConfigRow::AddParam => self.start_add_chat_param(),
            ChatConfigRow::Custom(idx) => {
                if let Some(param) = self.config.execution.extra_params.get(idx) {
                    self.chat_param_input = format!("{}={}", param.key, param.value);
                    self.chat_adding_param = false;
                    self.chat_editing_param = true;
                    self.status_message = format!(
                        "Editing custom param '{}' (key=value, Enter apply, Esc cancel)",
                        param.key
                    );
                }
            }
            ChatConfigRow::Builtin(field) => {
                if field.is_toggle_or_cycle() {
                    self.step_chat_param(1);
                    return;
                }
                self.chat_param_input = self.chat_param_raw_edit_value(field);
                self.chat_adding_param = false;
                self.chat_editing_param = true;
                self.status_message =
                    format!("Editing {}: type new value, Enter commit, Esc cancel", field.label());
            }
        }
    }

    pub fn commit_chat_param_edit(&mut self) {
        let raw = self.chat_param_input.trim().to_string();
        match self.selected_chat_row() {
            ChatConfigRow::AddParam => {
                self.chat_editing_param = false;
                self.chat_param_input.clear();
            }
            ChatConfigRow::Custom(idx) => {
                if let Some(param) = self.config.execution.extra_params.get_mut(idx) {
                    if let Some((k, v)) = raw.split_once('=').or_else(|| raw.split_once(':')) {
                        let key = k.trim();
                        if !key.is_empty() {
                            param.key = key.to_string();
                        }
                        param.value = v.trim().to_string();
                    } else if !raw.is_empty() {
                        param.value = raw.clone();
                    }
                    self.config_dirty = true;
                    self.status_message =
                        format!("Updated custom param: {} = {}", param.key, param.value);
                }
                self.chat_editing_param = false;
                self.chat_param_input.clear();
            }
            ChatConfigRow::Builtin(field) => {
                let target_id = self
                    .active_chat_target()
                    .map(|t| t.id.clone())
                    .unwrap_or_default();
                let provider_id = self
                    .config
                    .targets
                    .iter()
                    .find(|t| t.id == target_id)
                    .map(|t| t.provider_id.clone())
                    .unwrap_or_default();

                let mut updated = true;
                match field {
                    ChatParamField::BaseUrl => {
                        if let Some(p) = self.config.find_provider_mut(&provider_id) {
                            p.base_url = raw.clone();
                        }
                    }
                    ChatParamField::ApiKeyEnv => {
                        if let Some(p) = self.config.find_provider_mut(&provider_id) {
                            p.api_key_env = raw.clone();
                        }
                    }
                    ChatParamField::ApiKeyInline => {
                        if let Some(p) = self.config.find_provider_mut(&provider_id) {
                            p.api_key = raw.clone();
                        }
                    }
                    ChatParamField::CustomHeaders => {
                        if let Some(p) = self.config.find_provider_mut(&provider_id) {
                            p.custom_headers.clear();
                            for entry in raw.split(';') {
                                let part = entry.trim();
                                if part.is_empty() {
                                    continue;
                                }
                                if let Some((k, v)) =
                                    part.split_once(':').or_else(|| part.split_once('='))
                                {
                                    let key = k.trim();
                                    if !key.is_empty() {
                                        p.custom_headers
                                            .insert(key.to_string(), v.trim().to_string());
                                    }
                                }
                            }
                            self.config.execution.active_params.custom_headers =
                                !p.custom_headers.is_empty();
                        }
                    }
                    ChatParamField::CustomEndpoint => {
                        self.config.execution.custom_endpoint = raw.clone();
                        if !raw.is_empty() {
                            self.config.execution.active_params.custom_endpoint = true;
                        }
                    }
                    ChatParamField::TimeoutSec => match raw.parse::<u64>() {
                        Ok(v) => self.config.execution.timeout_sec = v.clamp(5, 600),
                        Err(_) => {
                            updated = false;
                            self.status_message = "Invalid timeout integer (5..600).".to_string();
                        }
                    },
                    ChatParamField::Temperature => match raw.parse::<f32>() {
                        Ok(v) => {
                            self.config.execution.temperature = v.clamp(0.0, 2.0);
                            self.config.execution.active_params.temperature = true;
                        }
                        Err(_) => {
                            updated = false;
                            self.status_message = "Invalid temperature float (0.0..2.0).".to_string();
                        }
                    },
                    ChatParamField::TopP => match raw.parse::<f32>() {
                        Ok(v) => {
                            self.config.execution.top_p = v.clamp(0.0, 1.0);
                            self.config.execution.active_params.top_p = true;
                        }
                        Err(_) => {
                            updated = false;
                            self.status_message = "Invalid top_p float (0.0..1.0).".to_string();
                        }
                    },
                    ChatParamField::MaxTokens => match raw.parse::<u32>() {
                        Ok(v) => {
                            self.config.execution.max_tokens = v.min(1_000_000);
                            self.config.execution.active_params.max_tokens = v > 0;
                        }
                        Err(_) => {
                            updated = false;
                            self.status_message = "Invalid max_tokens integer.".to_string();
                        }
                    },
                    ChatParamField::Seed => {
                        if raw.is_empty() || raw.eq_ignore_ascii_case("none") {
                            self.config.execution.seed = None;
                        } else {
                            match raw.parse::<u64>() {
                                Ok(v) => {
                                    self.config.execution.seed = Some(v);
                                    self.config.execution.active_params.seed = true;
                                }
                                Err(_) => {
                                    updated = false;
                                    self.status_message =
                                        "Invalid seed integer (or empty to clear).".to_string();
                                }
                            }
                        }
                    }
                    ChatParamField::TtsVoice => {
                        self.config.execution.tts_voice = if raw.is_empty() {
                            "alloy".to_string()
                        } else {
                            self.config.execution.active_params.tts_voice = true;
                            raw.clone()
                        };
                    }
                    ChatParamField::SystemPromptContent => {
                        self.config.system_prompt.content = raw.clone();
                        if !raw.is_empty() {
                            self.config.system_prompt.enabled = true;
                        }
                    }
                    ChatParamField::TargetSystemOverride => {
                        if let Some(t) = self.config.targets.iter_mut().find(|t| t.id == target_id) {
                            t.system_prompt_override =
                                if raw.is_empty() { None } else { Some(raw.clone()) };
                        }
                    }
                    ChatParamField::Concurrency => match raw.parse::<usize>() {
                        Ok(v) => self.config.execution.concurrency = v.clamp(1, 100),
                        Err(_) => {
                            updated = false;
                            self.status_message = "Invalid threads integer (1..100).".to_string();
                        }
                    },
                    _ => {}
                }

                if updated {
                    self.config_dirty = true;
                    self.status_message =
                        format!("Updated {}: {}", field.label(), self.chat_param_display_value(field));
                }
                self.chat_editing_param = false;
                self.chat_param_input.clear();
            }
        }
    }

    pub fn step_chat_param(&mut self, dir: i32) {
        let field = match self.selected_chat_row() {
            ChatConfigRow::Builtin(f) => f,
            ChatConfigRow::Custom(_) | ChatConfigRow::AddParam => {
                self.toggle_chat_row_activation();
                return;
            }
        };
        let target_id = self
            .active_chat_target()
            .map(|t| t.id.clone())
            .unwrap_or_default();

        match field {
            ChatParamField::TargetModel => {
                if !self.config.targets.is_empty() {
                    let cur = self
                        .config
                        .targets
                        .iter()
                        .position(|t| t.id == target_id)
                        .unwrap_or(0);
                    let len = self.config.targets.len();
                    let next = if dir >= 0 {
                        (cur + 1) % len
                    } else if cur == 0 {
                        len - 1
                    } else {
                        cur - 1
                    };
                    self.chat_target_id = self.config.targets[next].id.clone();
                }
            }
            ChatParamField::ProviderName => {
                if !self.config.providers.is_empty() {
                    let cur_pid = self
                        .config
                        .targets
                        .iter()
                        .find(|t| t.id == target_id)
                        .map(|t| t.provider_id.as_str())
                        .unwrap_or("");
                    let cur = self
                        .config
                        .providers
                        .iter()
                        .position(|p| p.id == cur_pid)
                        .unwrap_or(0);
                    let len = self.config.providers.len();
                    let next_p_idx = if dir >= 0 {
                        (cur + 1) % len
                    } else if cur == 0 {
                        len - 1
                    } else {
                        cur - 1
                    };
                    let next_pid = self.config.providers[next_p_idx].id.clone();
                    if let Some(t) = self.config.targets.iter().find(|t| t.provider_id == next_pid) {
                        self.chat_target_id = t.id.clone();
                    }
                }
            }
            ChatParamField::EndpointType => {
                self.config.execution.endpoint_type = if dir >= 0 {
                    self.config.execution.endpoint_type.next()
                } else {
                    self.config.execution.endpoint_type.prev()
                };
                self.config_dirty = true;
            }
            ChatParamField::Stream => {
                self.config.execution.stream = !self.config.execution.stream;
                self.config_dirty = true;
            }
            ChatParamField::TimeoutSec => {
                let next = if dir >= 0 {
                    self.config.execution.timeout_sec.saturating_add(10)
                } else {
                    self.config.execution.timeout_sec.saturating_sub(10)
                };
                self.config.execution.timeout_sec = next.clamp(5, 600);
                self.config_dirty = true;
            }
            ChatParamField::Temperature => {
                let next = ((self.config.execution.temperature + (dir as f32) * 0.05) * 100.0).round() / 100.0;
                self.config.execution.temperature = next.clamp(0.0, 2.0);
                self.config_dirty = true;
            }
            ChatParamField::TopP => {
                let next = ((self.config.execution.top_p + (dir as f32) * 0.05) * 100.0).round() / 100.0;
                self.config.execution.top_p = next.clamp(0.0, 1.0);
                self.config_dirty = true;
            }
            ChatParamField::MaxTokens => {
                let next = if dir >= 0 {
                    self.config.execution.max_tokens.saturating_add(128)
                } else {
                    self.config.execution.max_tokens.saturating_sub(128)
                };
                self.config.execution.max_tokens = next.min(1_000_000);
                self.config_dirty = true;
            }
            ChatParamField::Seed => {
                let next = match (self.config.execution.seed, dir >= 0) {
                    (None, true) => Some(42),
                    (None, false) => None,
                    (Some(0), false) => None,
                    (Some(v), true) => Some(v.saturating_add(1)),
                    (Some(v), false) => Some(v - 1),
                };
                self.config.execution.seed = next;
                self.config_dirty = true;
            }
            ChatParamField::SystemPromptEnabled => {
                self.config.system_prompt.enabled = !self.config.system_prompt.enabled;
                self.config_dirty = true;
            }
            ChatParamField::SystemPersona => {
                let total = SYSTEM_PERSONAS.len() + 1; // index 0..len-1 + len = None
                let cur = self
                    .config
                    .system_prompt
                    .persona
                    .as_deref()
                    .and_then(|id| SYSTEM_PERSONAS.iter().position(|p| p.id == id))
                    .unwrap_or(SYSTEM_PERSONAS.len());
                let next = if dir >= 0 {
                    (cur + 1) % total
                } else if cur == 0 {
                    total - 1
                } else {
                    cur - 1
                };
                if next < SYSTEM_PERSONAS.len() {
                    self.config.system_prompt.persona = Some(SYSTEM_PERSONAS[next].id.to_string());
                    self.config.system_prompt.enabled = true;
                } else {
                    self.config.system_prompt.persona = None;
                }
                self.config_dirty = true;
            }
            ChatParamField::EndpointFilesCount => {
                if !self.config.endpoint_files.is_empty() {
                    let any_enabled = self.config.endpoint_files.iter().any(|f| f.enabled);
                    for f in &mut self.config.endpoint_files {
                        f.enabled = !any_enabled;
                    }
                    self.config_dirty = true;
                }
            }
            ChatParamField::ExecutionMode => {
                self.config.execution.mode = self.config.execution.mode.toggle();
                self.config_dirty = true;
            }
            ChatParamField::Concurrency => {
                let next = if dir >= 0 {
                    self.config.execution.concurrency.saturating_add(1)
                } else {
                    self.config.execution.concurrency.saturating_sub(1)
                };
                self.config.execution.concurrency = next.clamp(1, 100);
                self.config_dirty = true;
            }
            ChatParamField::RandomizeOrder => {
                self.config.execution.randomize_order = !self.config.execution.randomize_order;
                self.config_dirty = true;
            }
            _ => {}
        }
        self.status_message = format!("{}: {}", field.label(), self.chat_param_display_value(field));
    }

    fn populate_chat_from_result_opt(&mut self, chosen: Option<&ModelRunResult>) {
        if let Some(res) = chosen {
            self.chat_target_id = res.target_id.clone();
            self.chat_last_result = Some(res.clone());
        } else {
            let tid = self
                .active_chat_target()
                .map(|t| t.id.clone())
                .unwrap_or_default();
            self.chat_target_id = tid.clone();
            self.chat_last_result = self.results.get(&tid).cloned();
        }

        self.chat_messages.clear();
        if !self.prompt.trim().is_empty() {
            self.chat_messages.push(ChatTurnMessage {
                role: "user".to_string(),
                content: self.prompt.clone(),
            });
        }
        if let Some(res) = chosen.or(self.chat_last_result.as_ref()) {
            let assistant_text = if !res.output.is_empty() {
                if let Some(ref err) = res.error {
                    format!("{}\n\n[ERROR: {}]", res.output, err)
                } else {
                    res.output.clone()
                }
            } else if let Some(ref err) = res.error {
                if let Some(ref adv) = res.advice {
                    format!("ERROR: {}\nADVICE: {}", err, adv)
                } else {
                    format!("ERROR: {}", err)
                }
            } else {
                String::new()
            };
            if !assistant_text.is_empty() {
                self.chat_messages.push(ChatTurnMessage {
                    role: "assistant".to_string(),
                    content: assistant_text,
                });
            }
        }

        self.chat_input.clear();
        self.chat_scroll = 0;
        self.chat_editing_param = false;
        self.chat_editing_composer = false;
        self.chat_focus = ChatFocus::Params;
        self.active_tab = ActiveTab::Chat;
    }

    pub fn open_chat_from_prompt(&mut self) {
        if let Some(item) = PROMPT_SUITES.get(self.selected_suite_idx) {
            let matches_any_suite = PROMPT_SUITES.iter().any(|s| s.prompt == self.prompt);
            if self.prompt.trim().is_empty() || matches_any_suite {
                self.prompt = item.prompt.to_string();
                self.run_title = item.title.to_string();
            }
        }
        let target_id = self
            .active_chat_target()
            .map(|t| t.id.clone())
            .unwrap_or_default();
        let cached = self.results.get(&target_id).cloned();
        self.populate_chat_from_result_opt(cached.as_ref());
        self.status_message = format!("Opened 7:Chat from Prompt ({})", self.run_title);
    }

    pub fn open_chat_from_selected_response(&mut self) {
        let ordered = self.ordered_results();
        if ordered.is_empty() {
            self.populate_chat_from_result_opt(None);
            self.status_message = "Opened 7:Chat".to_string();
            return;
        }
        let idx = self.selected_result_idx.min(ordered.len() - 1);
        let chosen = ordered[idx].clone();
        let model_label = chosen.model_name.clone();
        self.populate_chat_from_result_opt(Some(&chosen));
        self.status_message = format!("Opened 7:Chat with response from {}", model_label);
    }

    pub fn open_chat_from_waterfall(&mut self) {
        let sorted = self.sorted_waterfall_results();
        if sorted.is_empty() {
            self.populate_chat_from_result_opt(None);
            self.status_message = "Opened 7:Chat".to_string();
            return;
        }
        let idx = self.waterfall_selected_idx.min(sorted.len() - 1);
        let chosen = sorted[idx].clone();
        if let Some(pos) = self
            .ordered_results()
            .iter()
            .position(|r| r.target_id == chosen.target_id)
        {
            self.selected_result_idx = pos;
        }
        let model_label = chosen.model_name.clone();
        self.populate_chat_from_result_opt(Some(&chosen));
        self.status_message = format!("Opened 7:Chat from Waterfall ({})", model_label);
    }

    pub fn send_chat_turn(&mut self) {
        if self.chat_running || self.is_running {
            return;
        }
        let Some(target) = self.active_chat_target().cloned() else {
            self.status_message = "No target model configured for 7:Chat.".to_string();
            return;
        };

        let draft = self.chat_input.trim().to_string();
        if !draft.is_empty() {
            self.chat_messages.push(ChatTurnMessage {
                role: "user".to_string(),
                content: draft,
            });
            self.chat_input.clear();
        } else if self.chat_messages.is_empty() && !self.prompt.trim().is_empty() {
            self.chat_messages.push(ChatTurnMessage {
                role: "user".to_string(),
                content: self.prompt.clone(),
            });
        } else if self
            .chat_messages
            .last()
            .map(|m| m.role == "assistant")
            .unwrap_or(false)
        {
            if let Some(last) = self.chat_messages.last() {
                if last.content.starts_with("ERROR:") {
                    self.chat_messages.pop();
                } else {
                    self.status_message =
                        "Press 'i' to type a follow-up message before sending.".to_string();
                    return;
                }
            }
        }

        if self.chat_messages.is_empty() && self.config.matching_endpoint_files().is_empty() {
            self.status_message = "Enter a message or attach an endpoint file before sending.".to_string();
            return;
        }

        self.chat_messages.push(ChatTurnMessage {
            role: "assistant".to_string(),
            content: "...".to_string(),
        });
        self.chat_active_assistant_idx = Some(self.chat_messages.len() - 1);
        let send_history = self.chat_messages[..self.chat_messages.len() - 1].to_vec();

        let (abort_tx, abort_rx) = watch::channel(false);
        self.abort_tx = Some(abort_tx);
        self.chat_running = true;
        self.chat_editing_composer = false;
        self.status_message = format!(
            "Sending chat turn to {} ({})...",
            target.model,
            self.config.execution.endpoint_type.label()
        );
        spawn_chat_turn(
            self.config.clone(),
            target,
            send_history,
            self.engine_tx.clone(),
            abort_rx,
        );
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
                                let sorted = self.sorted_waterfall_results();
                                if idx < sorted.len() {
                                    if self.waterfall_selected_idx == idx {
                                        self.open_waterfall_selected_response();
                                    } else {
                                        self.waterfall_selected_idx = idx;
                                        self.status_message = format!(
                                            "Selected {} (press Enter/Space or click again to open response)",
                                            sorted[idx].model_name
                                        );
                                    }
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
                                    8 => {
                                        if col < area.x + area.width / 2 {
                                            self.config.execution.randomize_order =
                                                !self.config.execution.randomize_order;
                                            self.config_dirty = true;
                                            self.status_message = format!(
                                                "Random model order: {}",
                                                self.config.execution.randomize_order
                                            );
                                        } else {
                                            self.import_latest_results();
                                        }
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
                    ActiveTab::Chat => {
                        if self.chat_editing_param || self.chat_adding_param {
                            self.chat_editing_param = false;
                            self.chat_adding_param = false;
                            self.chat_param_input.clear();
                        }
                        if self.layout_zones.chat_params_area.contains(pos) {
                            let was_params = self.chat_focus == ChatFocus::Params;
                            self.chat_focus = ChatFocus::Params;
                            self.chat_editing_composer = false;
                            if let Some(idx) = Self::inner_list_row(
                                self.layout_zones.chat_params_area,
                                col,
                                row,
                                self.layout_zones.chat_params_offset,
                            ) {
                                let rows = self.chat_config_rows();
                                if let Some(&clicked_row) = rows.get(idx) {
                                    let was_selected =
                                        was_params && self.chat_selected_param_idx == idx;
                                    let clicked_checkbox = col
                                        <= self.layout_zones.chat_params_area.x.saturating_add(7);
                                    self.chat_selected_param_idx = idx;
                                    match clicked_row {
                                        ChatConfigRow::AddParam => {
                                            self.start_add_chat_param();
                                        }
                                        ChatConfigRow::Custom(ci) => {
                                            if clicked_checkbox {
                                                self.toggle_chat_row_activation();
                                            } else if was_selected {
                                                self.begin_edit_chat_param();
                                            } else if let Some(p) =
                                                self.config.execution.extra_params.get(ci)
                                            {
                                                self.status_message = format!(
                                                    "Custom param '{}': Space/[ ] toggle · Enter edit · Del remove",
                                                    p.key
                                                );
                                            }
                                        }
                                        ChatConfigRow::Builtin(field) => {
                                            if clicked_checkbox
                                                && self.is_chat_field_activated(field).is_some()
                                            {
                                                self.toggle_chat_row_activation();
                                            } else if was_selected {
                                                self.begin_edit_chat_param();
                                            } else {
                                                self.status_message = field.hint().to_string();
                                            }
                                        }
                                    }
                                }
                            }
                        } else if self.layout_zones.chat_messages_area.contains(pos) {
                            self.chat_focus = ChatFocus::Messages;
                            self.chat_editing_composer = false;
                        } else if self.layout_zones.chat_composer_area.contains(pos) {
                            self.chat_focus = ChatFocus::Composer;
                            self.chat_editing_composer = true;
                            self.status_message =
                                "Chat composer active (Enter to send, Shift+Enter newline, Esc exit)"
                                    .to_string();
                        }
                    }
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
                        if self.layout_zones.config_settings_area.contains(pos) {
                            if scroll_up {
                                self.config_settings_scroll =
                                    self.config_settings_scroll.saturating_sub(2);
                            } else {
                                self.config_settings_scroll =
                                    self.config_settings_scroll.saturating_add(2);
                            }
                            return;
                        }
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
                    ActiveTab::Chat => {
                        if self.layout_zones.chat_params_area.contains(pos) {
                            let max_idx = self.chat_config_rows().len().saturating_sub(1);
                            if scroll_up {
                                self.chat_selected_param_idx =
                                    self.chat_selected_param_idx.saturating_sub(1);
                            } else if self.chat_selected_param_idx < max_idx {
                                self.chat_selected_param_idx += 1;
                            }
                        } else if scroll_up {
                            self.chat_scroll = self.chat_scroll.saturating_sub(3);
                        } else {
                            self.chat_scroll = self.chat_scroll.saturating_add(3);
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
            chat_params_area: Rect::new(0, 3, 42, 20),
            chat_params_offset: 0,
            chat_messages_area: Rect::new(42, 3, 58, 15),
            chat_composer_area: Rect::new(42, 18, 58, 5),
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

    #[test]
    fn random_order_toggle_shuffles_and_imports_results_json() {
        let mut app = test_app();
        app.active_tab = ActiveTab::ConfigEditor;
        assert!(!app.config.execution.randomize_order);

        app.handle_key(KeyEvent::new(KeyCode::Char('N'), KeyModifiers::SHIFT));
        assert!(app.config.execution.randomize_order);

        let mut list = app.config.targets.clone();
        let original_ids: Vec<String> = list.iter().map(|t| t.id.clone()).collect();
        AppState::shuffle_targets_in_place(&mut list, 42);
        let shuffled_ids: Vec<String> = list.iter().map(|t| t.id.clone()).collect();
        assert_eq!(shuffled_ids.len(), original_ids.len());
        assert_ne!(shuffled_ids, original_ids);

        let sample_json = r#"{
          "run": {
            "id": "imp-1",
            "title": "Imported JSON Run",
            "createdAt": 1760000000000,
            "prompt": "Ping",
            "results": [
              {
                "targetId": "external-free-1",
                "modelName": "qwen-free",
                "providerName": "OpenRouter",
                "status": "completed",
                "output": "pong",
                "promptTokens": 2,
                "completionTokens": 1,
                "totalTokens": 3,
                "tokensPerSec": 40.0,
                "httpStatus": 200,
                "timing": { "queueMs": 1, "requestMs": 10, "ttfbMs": 20, "downloadMs": 5, "totalMs": 36 }
              }
            ]
          }
        }"#;
        let count = app.import_results_from_str(sample_json).expect("import json");
        assert_eq!(count, 1);
        assert_eq!(app.run_title, "Imported JSON Run");
        assert!(app.ordered_results().iter().any(|r| r.model_name == "qwen-free"));
    }

    #[test]
    fn waterfall_enter_and_space_open_selected_response() {
        let mut app = test_app();
        app.results.insert(
            app.config.targets[0].id.clone(),
            ModelRunResult {
                target_id: app.config.targets[0].id.clone(),
                model_name: app.config.targets[0].model.clone(),
                provider_name: "Ollama".into(),
                status: RunStatus::Completed,
                output: "First output".into(),
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                tokens_per_sec: 10.0,
                timing: Default::default(),
                http_status: Some(200),
                error: None,
                advice: None,
            },
        );
        app.results.insert(
            app.config.targets[1].id.clone(),
            ModelRunResult {
                target_id: app.config.targets[1].id.clone(),
                model_name: app.config.targets[1].model.clone(),
                provider_name: "Ollama".into(),
                status: RunStatus::Completed,
                output: "Second output".into(),
                prompt_tokens: 1,
                completion_tokens: 2,
                total_tokens: 3,
                tokens_per_sec: 50.0,
                timing: Default::default(),
                http_status: Some(200),
                error: None,
                advice: None,
            },
        );

        app.active_tab = ActiveTab::Waterfall;
        app.waterfall_sort = WaterfallSortField::Speed;
        app.waterfall_desc = true;
        app.waterfall_selected_idx = 0;
        app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
        assert_eq!(app.active_tab, ActiveTab::Responses);
        assert_eq!(app.selected_result_idx, 1);

        // Enter from Waterfall opens 7:Chat with the selected model & its response as msg
        app.active_tab = ActiveTab::Waterfall;
        app.waterfall_selected_idx = 1;
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.active_tab, ActiveTab::Chat);
        assert_eq!(app.selected_result_idx, 0);
        assert_eq!(app.chat_target_id, app.config.targets[0].id);
        assert!(app
            .chat_messages
            .iter()
            .any(|m| m.role == "assistant" && m.content.contains("First output")));
    }

    #[test]
    fn shift_up_and_down_scroll_responses_canvas() {
        let mut app = test_app();
        app.active_tab = ActiveTab::Responses;
        app.selected_result_idx = 1;
        app.output_scroll = 0;

        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT));
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT));
        assert_eq!(app.output_scroll, 6);
        assert_eq!(app.selected_result_idx, 1);

        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::SHIFT));
        assert_eq!(app.output_scroll, 3);
        assert_eq!(app.selected_result_idx, 1);

        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::SHIFT));
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::SHIFT));
        assert_eq!(app.output_scroll, 0);
    }

    #[test]
    fn enter_from_prompt_and_responses_opens_chat_with_scrollable_editable_config() {
        let mut app = test_app();

        // Enter from 1:Prompt opens 7:Chat with the active prompt as user msg
        app.active_tab = ActiveTab::PromptSuites;
        app.selected_suite_idx = 1;
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.active_tab, ActiveTab::Chat);
        assert_eq!(app.chat_messages.len(), 1);
        assert_eq!(app.chat_messages[0].role, "user");
        assert_eq!(app.chat_messages[0].content, PROMPT_SUITES[1].prompt);

        // Scroll down & up across all 23 editable send parameters
        assert_eq!(app.chat_selected_param_idx, 0);
        for _ in 0..30 {
            app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(app.chat_selected_param_idx, CHAT_PARAM_FIELDS.len() - 1);

        for _ in 0..12 {
            app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        }
        let temp_idx = CHAT_PARAM_FIELDS
            .iter()
            .position(|f| *f == ChatParamField::Temperature)
            .unwrap();
        app.chat_selected_param_idx = temp_idx;
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.chat_editing_param);
        app.chat_param_input = "0.42".to_string();
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(!app.chat_editing_param);
        assert!((app.config.execution.temperature - 0.42).abs() < 0.001);

        // Enter from 2:Responses opens 7:Chat with that target & response as assistant msg
        app.results.insert(
            app.config.targets[1].id.clone(),
            ModelRunResult {
                target_id: app.config.targets[1].id.clone(),
                model_name: app.config.targets[1].model.clone(),
                provider_name: "Ollama".into(),
                status: RunStatus::Completed,
                output: "Response msg content".into(),
                prompt_tokens: 4,
                completion_tokens: 6,
                total_tokens: 10,
                tokens_per_sec: 45.0,
                timing: Default::default(),
                http_status: Some(200),
                error: None,
                advice: None,
            },
        );
        app.active_tab = ActiveTab::Responses;
        app.selected_result_idx = 1;
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.active_tab, ActiveTab::Chat);
        assert_eq!(app.chat_target_id, app.config.targets[1].id);
        assert_eq!(app.chat_messages.len(), 2);
        assert_eq!(app.chat_messages[1].role, "assistant");
        assert_eq!(app.chat_messages[1].content, "Response msg content");

        // Scroll chat messages up & down
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT));
        assert_eq!(app.chat_scroll, 3);
        app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::SHIFT));
        assert_eq!(app.chat_scroll, 0);
    }

    #[test]
    fn chat_param_activation_checkboxes_and_add_param_work() {
        let mut app = test_app();
        app.active_tab = ActiveTab::Chat;
        app.chat_focus = ChatFocus::Params;

        // Toggle activation checkbox on Temperature via Space
        let temp_idx = CHAT_PARAM_FIELDS
            .iter()
            .position(|f| *f == ChatParamField::Temperature)
            .unwrap();
        app.chat_selected_param_idx = temp_idx;
        assert!(app.config.execution.active_params.temperature);
        app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
        assert!(!app.config.execution.active_params.temperature);
        app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
        assert!(app.config.execution.active_params.temperature);

        // Press 'a' to trigger + Add Param and commit key=value
        app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));
        assert!(app.chat_adding_param);
        for ch in "presence_penalty=0.25".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE));
        }
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(!app.chat_adding_param);
        assert_eq!(app.config.execution.extra_params.len(), 1);
        assert_eq!(app.config.execution.extra_params[0].key, "presence_penalty");
        assert_eq!(app.config.execution.extra_params[0].value, "0.25");
        assert!(app.config.execution.extra_params[0].enabled);

        // Toggle custom param checkbox with Space, then delete with Delete
        app.handle_key(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));
        assert!(!app.config.execution.extra_params[0].enabled);
        app.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));
        assert!(app.config.execution.extra_params.is_empty());
    }
}


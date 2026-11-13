use crate::app::{ActiveTab, AppState};
use crate::config::{ExecutionMode, ThemeId};
use crate::diff::{compute_token_diff, DiffOp};
use crate::engine::RunStatus;
use crate::suites::PROMPT_SUITES;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    symbols,
    text::{Line, Span},
    widgets::{
        Axis, Block, Borders, Cell, Chart, Dataset, GraphType, List, ListItem, Paragraph, Row,
        Table, Tabs, Wrap,
    },
    Frame,
};

struct ThemePalette {
    bg: Color,
    surface: Color,
    text: Color,
    muted: Color,
    accent: Color,
    success: Color,
    warning: Color,
    error: Color,
}

fn palette_for(theme: ThemeId) -> ThemePalette {
    match theme {
        ThemeId::Light => ThemePalette {
            bg: Color::Rgb(248, 250, 252),
            surface: Color::Rgb(255, 255, 255),
            text: Color::Rgb(15, 23, 42),
            muted: Color::Rgb(100, 116, 139),
            accent: Color::Rgb(37, 99, 235),
            success: Color::Rgb(22, 163, 74),
            warning: Color::Rgb(217, 119, 6),
            error: Color::Rgb(220, 38, 38),
        },
        ThemeId::Dark => ThemePalette {
            bg: Color::Rgb(11, 15, 23),
            surface: Color::Rgb(17, 24, 39),
            text: Color::Rgb(241, 245, 249),
            muted: Color::Rgb(148, 163, 184),
            accent: Color::Rgb(59, 130, 246),
            success: Color::Rgb(34, 197, 94),
            warning: Color::Rgb(245, 158, 11),
            error: Color::Rgb(239, 68, 68),
        },
        ThemeId::SepiaLight => ThemePalette {
            bg: Color::Rgb(245, 239, 228),
            surface: Color::Rgb(251, 247, 239),
            text: Color::Rgb(44, 34, 30),
            muted: Color::Rgb(122, 101, 90),
            accent: Color::Rgb(180, 83, 9),
            success: Color::Rgb(21, 128, 61),
            warning: Color::Rgb(180, 83, 9),
            error: Color::Rgb(185, 28, 28),
        },
        ThemeId::SepiaDark => ThemePalette {
            bg: Color::Rgb(23, 19, 16),
            surface: Color::Rgb(33, 27, 23),
            text: Color::Rgb(239, 230, 216),
            muted: Color::Rgb(166, 149, 129),
            accent: Color::Rgb(217, 119, 6),
            success: Color::Rgb(74, 222, 128),
            warning: Color::Rgb(251, 191, 36),
            error: Color::Rgb(248, 113, 113),
        },
        ThemeId::GreenishSepia => ThemePalette {
            bg: Color::Rgb(233, 239, 228),
            surface: Color::Rgb(242, 246, 238),
            text: Color::Rgb(26, 40, 29),
            muted: Color::Rgb(90, 111, 94),
            accent: Color::Rgb(21, 128, 61),
            success: Color::Rgb(21, 128, 61),
            warning: Color::Rgb(161, 98, 7),
            error: Color::Rgb(185, 28, 28),
        },
    }
}

pub fn draw(frame: &mut Frame, app: &AppState) {
    let pal = palette_for(app.theme());
    let root_block = Block::default().style(Style::default().bg(pal.bg).fg(pal.text));
    frame.render_widget(root_block, frame.area());

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(2),
        ])
        .split(frame.area());

    draw_header(frame, app, &pal, chunks[0]);

    match app.active_tab {
        ActiveTab::PromptSuites => draw_prompt_tab(frame, app, &pal, chunks[1]),
        ActiveTab::Responses => draw_responses_tab(frame, app, &pal, chunks[1]),
        ActiveTab::Waterfall => draw_waterfall_tab(frame, app, &pal, chunks[1]),
        ActiveTab::DiffCompare => draw_diff_tab(frame, app, &pal, chunks[1]),
        ActiveTab::CapabilityGraph => draw_graph_tab(frame, app, &pal, chunks[1]),
        ActiveTab::ConfigEditor => draw_config_tab(frame, app, &pal, chunks[1]),
    }

    draw_footer(frame, app, &pal, chunks[2]);
}

fn draw_header(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let titles = [
        "1:Prompt",
        "2:Responses",
        "3:Waterfall",
        "4:Diff",
        "5:XY Graph",
        "6:Config",
    ];
    let dirty_mark = if app.config_dirty { " *" } else { "" };
    let header_title = format!(
        " BenchForge TUI · {} ({}){} ",
        app.theme().label(),
        app.config_path.display(),
        dirty_mark
    );

    let tabs = Tabs::new(titles.iter().map(|t| Line::from(*t)).collect::<Vec<_>>())
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(header_title)
                .style(Style::default().bg(pal.surface).fg(pal.text)),
        )
        .select(app.active_tab.index())
        .style(Style::default().fg(pal.muted))
        .highlight_style(
            Style::default()
                .fg(pal.accent)
                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
        );
    frame.render_widget(tabs, area);
}

fn draw_footer(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let key_hints = match app.active_tab {
        ActiveTab::PromptSuites if app.editing_prompt => "EDIT MODE: Type prompt · Esc Exit Edit",
        ActiveTab::PromptSuites => "i Edit Prompt · Enter Load Suite · r Run · t Theme · q Quit",
        ActiveTab::ConfigEditor => "Space Toggle Model · m Mode · +/- Threads · [/] Timeout · p SysPrompt · s Save · q Quit",
        ActiveTab::DiffCompare => "a Cycle Baseline · b Cycle Candidate · r Run · e Export · q Quit",
        _ => "1-6 Tabs · r Run · R Bulk Retry · x Abort · s Save Config · e Export · t Theme · q Quit",
    };

    let footer = Paragraph::new(vec![
        Line::from(vec![
            Span::styled(
                if app.is_running { "[RUNNING] " } else { "[READY] " },
                Style::default()
                    .fg(if app.is_running { pal.warning } else { pal.success })
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(&app.status_message, Style::default().fg(pal.text)),
        ]),
        Line::from(Span::styled(key_hints, Style::default().fg(pal.muted))),
    ]);
    frame.render_widget(footer, area);
}

fn draw_prompt_tab(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(area);

    let items: Vec<ListItem> = PROMPT_SUITES
        .iter()
        .enumerate()
        .map(|(idx, s)| {
            let selected = idx == app.selected_suite_idx;
            let style = if selected {
                Style::default().fg(pal.accent).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(pal.text)
            };
            ListItem::new(Line::from(vec![
                Span::styled(if selected { "> " } else { "  " }, style),
                Span::styled(format!("{} ", s.title), style),
                Span::styled(format!("({})", s.category), Style::default().fg(pal.muted)),
            ]))
        })
        .collect();

    let suite_list = List::new(items).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Prompt Test Suites (Nerdy Kings 18 + Classic + HTML) ")
            .style(Style::default().bg(pal.surface).fg(pal.text)),
    );
    frame.render_widget(suite_list, cols[0]);

    let prompt_title = if app.editing_prompt {
        format!(" Active Prompt [EDITING]: {} ", app.run_title)
    } else {
        format!(" Active Prompt (press 'i' to edit): {} ", app.run_title)
    };
    let prompt_box = Paragraph::new(app.prompt.as_str())
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(prompt_title)
                .border_style(Style::default().fg(if app.editing_prompt { pal.accent } else { pal.muted }))
                .style(Style::default().bg(pal.surface).fg(pal.text)),
        );
    frame.render_widget(prompt_box, cols[1]);
}

fn draw_responses_tab(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let results = app.ordered_results();
    if results.is_empty() {
        let empty = Paragraph::new("No active target models. Open tab 6:Config and press Space to enable models.")
            .block(Block::default().borders(Borders::ALL).title(" Responses "));
        frame.render_widget(empty, area);
        return;
    }

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(32), Constraint::Percentage(68)])
        .split(area);

    let list_items: Vec<ListItem> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let sel = i == app.selected_result_idx;
            let status_color = match r.status {
                RunStatus::Completed => pal.success,
                RunStatus::Error => pal.error,
                RunStatus::Streaming | RunStatus::Connecting => pal.accent,
                RunStatus::Aborted => pal.warning,
                _ => pal.muted,
            };
            ListItem::new(Line::from(vec![
                Span::styled(if sel { "> " } else { "  " }, Style::default().fg(pal.accent)),
                Span::styled(
                    format!("{} ", r.model_name),
                    Style::default().fg(pal.text).add_modifier(if sel { Modifier::BOLD } else { Modifier::empty() }),
                ),
                Span::styled(format!("[{}] {:.1} t/s", r.status.label(), r.tokens_per_sec), Style::default().fg(status_color)),
            ]))
        })
        .collect();

    let model_list = List::new(list_items).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Targets ")
            .style(Style::default().bg(pal.surface).fg(pal.text)),
    );
    frame.render_widget(model_list, cols[0]);

    let active = &results[app.selected_result_idx.min(results.len() - 1)];
    let ttfb = active
        .timing
        .ttfb_ms
        .map(|v| format!("{:.0} ms", v))
        .unwrap_or_else(|| "-".to_string());

    let mut content = String::new();
    if let Some(ref err) = active.error {
        content.push_str(&format!("ERROR: {}\n", err));
        if let Some(ref adv) = active.advice {
            content.push_str(&format!("ADVICE: {}\n\n", adv));
        }
    }
    if active.output.is_empty() && active.error.is_none() {
        content.push_str("Press 'r' to execute benchmark across enabled targets.");
    } else {
        content.push_str(&active.output);
    }

    let detail_title = format!(
        " {} ({}) · TTFB {} · {:.1} tok/s · {} out tok · {:.0} ms ",
        active.model_name,
        active.provider_name,
        ttfb,
        active.tokens_per_sec,
        active.completion_tokens,
        active.timing.total_ms
    );

    let detail = Paragraph::new(content)
        .wrap(Wrap { trim: false })
        .scroll((app.output_scroll, 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(detail_title)
                .style(Style::default().bg(pal.surface).fg(pal.text)),
        );
    frame.render_widget(detail, cols[1]);
}

fn draw_waterfall_tab(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let results = app.ordered_results();
    let max_ms = results
        .iter()
        .map(|r| r.timing.total_ms)
        .fold(1.0_f64, f64::max);

    let rows: Vec<Row> = results
        .iter()
        .map(|r| {
            let ttfb = r
                .timing
                .ttfb_ms
                .map(|v| format!("{:.1} ms", v))
                .unwrap_or_else(|| "-".to_string());
            let bar_len = ((r.timing.total_ms / max_ms) * 20.0).round() as usize;
            let bar = "#".repeat(bar_len.max(1));
            Row::new(vec![
                Cell::from(r.model_name.clone()),
                Cell::from(r.status.label()),
                Cell::from(format!("{:.1} ms", r.timing.queue_ms)),
                Cell::from(format!("{:.1} ms", r.timing.request_ms)),
                Cell::from(ttfb),
                Cell::from(format!("{:.1} ms", r.timing.download_ms)),
                Cell::from(format!("{:.1} ms", r.timing.total_ms)),
                Cell::from(format!("{:.1} t/s", r.tokens_per_sec)),
                Cell::from(bar),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(22),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(11),
            Constraint::Length(11),
            Constraint::Length(10),
            Constraint::Min(22),
        ],
    )
    .header(
        Row::new(vec![
            "Model", "Status", "Queue", "Request", "TTFB", "Download", "Total", "Speed", "Timeline",
        ])
        .style(Style::default().fg(pal.accent).add_modifier(Modifier::BOLD)),
    )
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(" DevTools Network Waterfall ")
            .style(Style::default().bg(pal.surface).fg(pal.text)),
    );

    frame.render_widget(table, area);
}

fn draw_diff_tab(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let results = app.ordered_results();
    if results.len() < 2 {
        let p = Paragraph::new("Run at least two models to inspect token-level diffs (press 'a'/'b' to select).")
            .block(Block::default().borders(Borders::ALL).title(" Diff Compare "));
        frame.render_widget(p, area);
        return;
    }

    let left = &results[app.diff_left_idx.min(results.len() - 1)];
    let right = &results[app.diff_right_idx.min(results.len() - 1)];
    let (segments, stats) = compute_token_diff(&left.output, &right.output);

    let spans: Vec<Span> = segments
        .into_iter()
        .map(|seg| match seg.op {
            DiffOp::Equal => Span::styled(seg.text, Style::default().fg(pal.text)),
            DiffOp::Insert => Span::styled(
                seg.text,
                Style::default().fg(pal.success).add_modifier(Modifier::BOLD),
            ),
            DiffOp::Delete => Span::styled(
                seg.text,
                Style::default()
                    .fg(pal.error)
                    .add_modifier(Modifier::CROSSED_OUT),
            ),
        })
        .collect();

    let title = format!(
        " Diff: {} (A) vs {} (B) · Similarity {}% · +{} / -{} tokens ",
        left.model_name, right.model_name, stats.similarity_pct, stats.insertions, stats.deletions
    );

    let diff_view = Paragraph::new(Line::from(spans))
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(title)
                .style(Style::default().bg(pal.surface).fg(pal.text)),
        );
    frame.render_widget(diff_view, area);
}

fn draw_graph_tab(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let results = app.ordered_results();
    let points: Vec<(f64, f64)> = results
        .iter()
        .filter(|r| r.status == RunStatus::Completed || r.completion_tokens > 0)
        .map(|r| (r.timing.ttfb_ms.unwrap_or(r.timing.total_ms), r.tokens_per_sec))
        .collect();

    let max_x = points.iter().map(|p| p.0).fold(100.0_f64, f64::max) * 1.15;
    let max_y = points.iter().map(|p| p.1).fold(20.0_f64, f64::max) * 1.2;

    let datasets = vec![Dataset::default()
        .name("Models (TTFB ms vs Speed tok/s)")
        .marker(symbols::Marker::Dot)
        .graph_type(GraphType::Scatter)
        .style(Style::default().fg(pal.accent))
        .data(&points)];

    let chart = Chart::new(datasets)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" XY Capability Scatter Plot (TTFB ms vs Throughput tok/s) ")
                .style(Style::default().bg(pal.surface).fg(pal.text)),
        )
        .x_axis(
            Axis::default()
                .title("TTFB Latency (ms)")
                .style(Style::default().fg(pal.muted))
                .bounds([0.0, max_x])
                .labels(vec![
                    Span::raw("0"),
                    Span::raw(format!("{:.0}", max_x / 2.0)),
                    Span::raw(format!("{:.0}", max_x)),
                ]),
        )
        .y_axis(
            Axis::default()
                .title("Speed (tok/s)")
                .style(Style::default().fg(pal.muted))
                .bounds([0.0, max_y])
                .labels(vec![
                    Span::raw("0"),
                    Span::raw(format!("{:.0}", max_y / 2.0)),
                    Span::raw(format!("{:.0}", max_y)),
                ]),
        );

    frame.render_widget(chart, area);
}

fn draw_config_tab(frame: &mut Frame, app: &AppState, pal: &ThemePalette, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .split(area);

    // Left: Execution, System Prompt & Providers Summary
    let mode_label = match app.config.execution.mode {
        ExecutionMode::Parallel => "Parallel",
        ExecutionMode::Sequential => "Sequential",
    };
    let persona_label = app
        .config
        .system_prompt
        .persona
        .as_deref()
        .unwrap_or("custom/none");

    let mut lines = vec![
        Line::from(Span::styled(
            format!("Config File: {}", app.config_path.display()),
            Style::default().fg(pal.accent).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(format!(
            "Execution Mode [m]: {}   Threads [+/-]: {}",
            mode_label, app.config.execution.concurrency
        )),
        Line::from(format!(
            "Timeout [[/]]: {}s        SSE Stream [v]: {}",
            app.config.execution.timeout_sec, app.config.execution.stream
        )),
        Line::from(format!(
            "Temperature: {:.2}        Max Tokens: {}",
            app.config.execution.temperature, app.config.execution.max_tokens
        )),
        Line::from(format!(
            "System Prompt [p]: {}   Persona [P]: {}",
            app.config.system_prompt.enabled, persona_label
        )),
        Line::from(format!("Theme [t]: {}", app.theme().label())),
        Line::from(""),
        Line::from(Span::styled(
            "Configured Providers & Key Status:",
            Style::default().fg(pal.accent).add_modifier(Modifier::BOLD),
        )),
    ];

    for p in &app.config.providers {
        lines.push(Line::from(format!(
            "  • {} ({}) -> {} [{}]",
            p.name,
            p.base_url,
            p.key_status_label(),
            p.models.join(", ")
        )));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        format!(
            "Supabase Sync: {} (auto_sync={})",
            if app.config.supabase.url.is_empty() {
                "unconfigured"
            } else {
                &app.config.supabase.url
            },
            app.config.supabase.auto_sync
        ),
        Style::default().fg(pal.muted),
    )));

    let settings_panel = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Execution & Provider Configuration ")
            .style(Style::default().bg(pal.surface).fg(pal.text)),
    );
    frame.render_widget(settings_panel, cols[0]);

    // Right: Interactive Targets Toggle List
    let target_items: Vec<ListItem> = app
        .config
        .targets
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let sel = i == app.selected_config_idx;
            let mark = if t.enabled { "[x]" } else { "[ ]" };
            let style = if sel {
                Style::default().fg(pal.accent).add_modifier(Modifier::BOLD)
            } else if t.enabled {
                Style::default().fg(pal.text)
            } else {
                Style::default().fg(pal.muted)
            };
            ListItem::new(Line::from(vec![
                Span::styled(if sel { "> " } else { "  " }, style),
                Span::styled(format!("{} {} ", mark, t.model), style),
                Span::styled(format!("@ {}", t.provider_id), Style::default().fg(pal.muted)),
            ]))
        })
        .collect();

    let targets_list = List::new(target_items).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Target Models (Space/Enter to Toggle, s to Save TOML) ")
            .style(Style::default().bg(pal.surface).fg(pal.text)),
    );
    frame.render_widget(targets_list, cols[1]);
}

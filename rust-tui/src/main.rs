mod app;
mod config;
mod diff;
mod engine;
mod export;
mod suites;
mod ui;

use anyhow::Result;
use app::AppState;
use clap::{Parser, Subcommand};
use config::BenchConfig;
use crossterm::{
    event::{self, Event},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use engine::{discover_provider_models, spawn_benchmark_batch, EngineEvent};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

#[derive(Parser)]
#[command(
    name = "benchforge",
    version,
    about = "BenchForge Rust TUI — LLM Multi-Tester & Benchmark Workbench"
)]
struct Cli {
    /// Path to benchforge.toml configuration file
    #[arg(short, long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Scaffold a default benchforge.toml configuration file
    Init {
        #[arg(short, long)]
        force: bool,
    },
    /// Inspect and validate the resolved configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Run a headless benchmark batch (CI/CD mode)
    Run {
        #[arg(short, long)]
        prompt: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Validate TOML syntax, provider mappings, and resolved env keys
    Validate,
    /// Print the effective merged configuration as TOML
    Show,
    /// Discover models from each provider endpoint and aggregate into TOML
    Refresh,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    if let Some(cmd) = cli.command {
        return handle_subcommand(cmd, cli.config.as_deref()).await;
    }

    let loaded = BenchConfig::load(cli.config.as_deref())?;
    run_tui(loaded.config, loaded.source_path, loaded.from_disk).await
}

async fn handle_subcommand(cmd: Commands, explicit_cfg: Option<&std::path::Path>) -> Result<()> {
    match cmd {
        Commands::Init { force } => {
            let target = explicit_cfg
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("benchforge.toml"));
            if target.exists() && !force {
                anyhow::bail!(
                    "{} already exists (pass --force to overwrite)",
                    target.display()
                );
            }
            let cfg = BenchConfig::default();
            cfg.save_to_path(&target)?;
            println!("Created configuration file at {}", target.display());
            Ok(())
        }
        Commands::Config { action } => {
            let loaded = BenchConfig::load(explicit_cfg)?;
            match action {
                ConfigAction::Validate => {
                    println!(
                        "Configuration OK (source: {}, from_disk: {})",
                        loaded.source_path.display(),
                        loaded.from_disk
                    );
                    for p in &loaded.config.providers {
                        println!("  Provider [{}] {} -> {}", p.id, p.base_url, p.key_status_label());
                    }
                    println!(
                        "  Enabled targets: {}/{}",
                        loaded.config.enabled_targets().len(),
                        loaded.config.targets.len()
                    );
                    Ok(())
                }
                ConfigAction::Show => {
                    println!("{}", toml::to_string_pretty(&loaded.config)?);
                    Ok(())
                }
                ConfigAction::Refresh => {
                    let mut cfg = loaded.config;
                    let providers = cfg.providers.clone();
                    let mut total_added_targets = 0usize;
                    for p in &providers {
                        match discover_provider_models(p).await {
                            Ok(models) => {
                                let (added_p, added_t) =
                                    cfg.aggregate_provider_models(&p.id, &models);
                                total_added_targets += added_t;
                                println!(
                                    "  [OK] {} ({}): {} discovered (+{} provider, +{} targets)",
                                    p.name, p.base_url, models.len(), added_p, added_t
                                );
                            }
                            Err(err) => {
                                println!("  [ERR] {} ({}): {}", p.name, p.base_url, err);
                            }
                        }
                    }
                    cfg.save_to_path(&loaded.source_path)?;
                    println!(
                        "Saved {} (+{} new targets aggregated)",
                        loaded.source_path.display(),
                        total_added_targets
                    );
                    Ok(())
                }
            }
        }
        Commands::Run { prompt, json } => {
            let loaded = BenchConfig::load(explicit_cfg)?;
            let targets: Vec<_> = loaded.config.enabled_targets().into_iter().cloned().collect();
            let (tx, mut rx) = mpsc::unbounded_channel();
            let (_abort_tx, abort_rx) = watch::channel(false);
            spawn_benchmark_batch(loaded.config, targets, prompt, tx, abort_rx);

            let mut map = std::collections::HashMap::new();
            while let Some(ev) = rx.recv().await {
                match ev {
                    EngineEvent::Update(res) => {
                        map.insert(res.target_id.clone(), res);
                    }
                    EngineEvent::ModelsRefreshed { .. } => {}
                    EngineEvent::BatchFinished => break,
                }
            }
            let results: Vec<_> = map.into_values().collect();
            if json {
                println!("{}", serde_json::to_string_pretty(&results)?);
            } else {
                for r in results {
                    println!(
                        "[{}] {} ({}) - {:.1} tok/s, {:.0} ms",
                        r.status.label(),
                        r.model_name,
                        r.provider_name,
                        r.tokens_per_sec,
                        r.timing.total_ms
                    );
                }
            }
            Ok(())
        }
    }
}

async fn run_tui(config: BenchConfig, config_path: PathBuf, from_disk: bool) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let (engine_tx, mut engine_rx) = mpsc::unbounded_channel();
    let mut app = AppState::new(config, config_path, from_disk, engine_tx);

    let res = event_loop(&mut terminal, &mut app, &mut engine_rx).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    res
}

async fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut AppState,
    engine_rx: &mut mpsc::UnboundedReceiver<EngineEvent>,
) -> Result<()> {
    loop {
        while let Ok(ev) = engine_rx.try_recv() {
            app.handle_engine_event(ev);
        }

        terminal.draw(|f| ui::draw(f, app))?;

        if app.should_quit {
            break;
        }

        if event::poll(Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                app.handle_key(key);
            }
        }
    }
    Ok(())
}

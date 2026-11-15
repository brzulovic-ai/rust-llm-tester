# BenchForge Rust TUI

Terminal-native LLM Multi-Tester & Benchmark Workbench built with `ratatui`, `crossterm`, `tokio`, and `reqwest`, featuring full TOML/environment/CLI configuration management.

## Quick Start

```bash
cd rust-tui

# 1. Scaffold a config file in ./benchforge.toml (or ~/.config/benchforge/config.toml)
cargo run -- init

# 2. Validate configuration & resolved API key env vars
cargo run -- config validate

# 3. Discover models from provider endpoints and aggregate into benchforge.toml
cargo run -- config refresh

# 4. Launch the interactive TUI
cargo run --release
```

## Configuration Precedence

1. Explicit `--config <path>` CLI argument
2. `./benchforge.toml` in the current working directory
3. OS user config directory (`~/.config/benchforge/config.toml` on Linux/macOS, `%APPDATA%\benchforge\config.toml` on Windows)
4. Built-in defaults

Environment overrides:
- `BENCHFORGE_THEME` (`light`, `dark`, `sepia-light`, `sepia-dark`, `greenish-sepia`)
- `BENCHFORGE_CONCURRENCY` (`1..=10`)
- `BENCHFORGE_TIMEOUT` (seconds)
- Provider keys are resolved safely via `api_key_env` (e.g. `OPENAI_API_KEY`, `GROQ_API_KEY`, `LITELLM_API_KEY`) so secrets do not need to be stored in plaintext TOML.

## TUI Keybindings

- `1`–`6`: Switch views (`1` Prompt & Suites, `2` Responses, `3` Network Waterfall, `4` Diff Compare, `5` XY Graph, `6` Config Editor)
- `↑` / `↓` (in `1:Prompt`): Highlight and preview test suites below the Active Prompt canvas; press `Enter`/`Space` to load
- `↑` / `↓` & `PgUp` / `PgDn` (`J` / `K`) (in `2:Responses`): Navigate target models (auto-scrolling list) and scroll model output
- `o` / `←` / `→` & `O` / `v` / `Space` (in `3:Waterfall`): Change sort column (`Config Order`, `Total`, `TTFB`, `Speed`, `Model`, `Status`, `Queue`, `Request`, `Download`) and toggle Asc/Desc order
- `Shift+Tab` (or `←` / `→` / `h` / `l` in `6:Config`): Cycle focus across **Target Providers** → **Target Models** → **Model Filter**
- `/` or `f` (in `6:Config`): Jump straight into the **Model Filter** textbox (`Enter`/`↓` to browse matches, `Ctrl+D` deselects matches, `Ctrl+A` selects matches, `Esc` to clear)
- `Space` / `Enter` (in `6:Config`): Rapidly enable/disable all models for the selected provider, or toggle an individual filtered model
- `u` / `a` (in `6:Config`): Deselect (`u`) or select (`a`) all models matching the active filter
- `d` / `D` (in `6:Config`): Refresh models for selected provider (`d`) or all providers (`D`) and aggregate newly discovered models into TOML
- `r`: Run benchmark (or Bulk Retry failed targets with `R`)
- `x`: Abort active run
- `t`: Cycle theme (`Dark`, `Light`, `Sepia Light`, `Sepia Dark`, `Greenish Sepia`)
- `s`: Save current configuration to active config path (automatically creates a `<config>.bak` backup of the previous file before overwriting)
- `e`: Export JSON + CSV results to `./exports/`
- `j` / `k` or `↑` / `↓`: Navigate lists / scroll outputs
- `Tab`: Cycle focus panes
- `q` / `Ctrl+C`: Quit

## Headless CI Mode

```bash
cargo run -- run --prompt "Explain Raft Pre-Vote" --json > benchmark.json
```

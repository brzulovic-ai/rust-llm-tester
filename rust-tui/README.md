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
- `BENCHFORGE_CONCURRENCY` (`1..=100`)
- `BENCHFORGE_TIMEOUT` (seconds)
- Endpoint files for `/v1/audio/*` and `custom` multipart uploads can be configured via `[[endpoint_files]]` entries in `benchforge.toml` (`path`, `endpoint_type`, `field_name`, `mime_type`, `enabled`).
- Provider keys are resolved safely via `api_key_env` (e.g. `OPENAI_API_KEY`, `GROQ_API_KEY`, `LITELLM_API_KEY`) so secrets do not need to be stored in plaintext TOML.

## TUI Keybindings

- `1`–`6`: Switch views (`1` Prompt & Suites, `2` Responses, `3` Network Waterfall, `4` Diff Compare, `5` XY Graph, `6` Config Editor)
- `↑` / `↓` (in `1:Prompt`): Highlight and preview test suites below the Active Prompt canvas; press `Enter`/`Space` to load
- `↑` / `↓` & `PgUp` / `PgDn` (`J` / `K`) (in `2:Responses`): Navigate target models (auto-scrolling list) and scroll model output
- `o` / `←` / `→` & `O` / `v` / `Space` (in `3:Waterfall`): Change sort column (`Config Order`, `Total`, `TTFB`, `Speed`, `Model`, `Status`, `Queue`, `Request`, `Download`) and toggle Asc/Desc order
- `Shift+Tab` (or `←` / `→` / `h` / `l` in `6:Config`): Cycle focus across **Target Providers** → **Target Models** → **Model Filter** → **Saved Subgroups**
- `/` or `f` (in `6:Config`): Jump straight into the **Model Filter** textbox (`Enter`/`↓` to browse matches, `Ctrl+D` deselects matches, `Ctrl+A` selects matches, `Ctrl+G` saves subgroup, `Esc` to clear)
- `Space` / `Enter` (in `6:Config`): Rapidly enable/disable all models for the selected provider, toggle an individual filtered model, or in **Saved Subgroups** toggle (`Space`) / exclusively activate (`Enter`) a saved subgroup & filter (`Del`/`Backspace` deletes)
- `g` / `Ctrl+G` (in `6:Config`): Save the current filter + enabled model selection as a named subgroup (`[[subgroups]]`) into TOML (defaults to active filter name if untouched)
- `u` / `a` (in `6:Config`): Deselect (`u`) or select (`a`) all models matching the active filter
- `d` / `D` (in `6:Config`): Refresh models for selected provider (`d`) or all providers (`D`) and aggregate newly discovered models into TOML
- `+/-` (in `6:Config`): Adjust concurrent worker pool size (`1..=100` threads)
- `E` (in `6:Config`): Cycle Endpoint Type (`/v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/audio/speech`, `/v1/embeddings`, `/v1/responses`, `Custom Endpoint`)
- `p` / `P` (in `6:Config`): Toggle System Prompt (`p`) or cycle 9 Engineering, Daily Use, and DevOps/SRE personas (`P`)
- `r`: Run benchmark (or Bulk Retry failed targets with `R`)
- `x`: Abort active run
- `t`: Cycle theme (`Dark`, `Light`, `Sepia Light`, `Sepia Dark`, `Greenish Sepia`)
- `s`: Save current configuration to active config path (automatically creates a `<config>.bak` backup of the previous file before overwriting)
- `e`: Export JSON + CSV results to `./exports/`
- `j` / `k` or `↑` / `↓`: Navigate lists / scroll outputs
- `Tab`: Cycle focus panes
- `q` / `Ctrl+C`: Quit

## Mouse Support

Full mouse capture (`crossterm::event::EnableMouseCapture`) is enabled across the TUI:
- **Top Tab Bar**: Left-click any tab (`1:Prompt`–`6:Config`) to switch views, or scroll the wheel over the header to cycle tabs.
- **`1:Prompt`**: Click a suite row to preview it (click again or click the preview box to load into Active Prompt); click **Active Prompt** to enter edit mode (click outside or press `Esc` to finish).
- **`2:Responses`**: Click targets in the left list or scroll the wheel over the target list or response output pane.
- **`3:Waterfall`**: Click column headers (`Model`, `Status`, `Queue`, `Request`, `TTFB`, `Download`, `Total`, `Speed`) to sort or flip Asc/Desc order; click or scroll rows.
- **`4:Diff`**: Click the left or right half of the diff pane to cycle Baseline (A) or Candidate (B).
- **`6:Config`**: Click **Target Providers**, **Model Filter**, **Target Models**, or **Saved Subgroups** to focus them; click `[ ]`/`[x]` checkboxes (or click a selected row again) to toggle models/providers/subgroups or solo subgroups; click rows in **Execution & Provider Configuration** (`Mode`, `Stream`, `System Prompt` / `Persona`, `Theme`) to toggle settings; scroll wheel over any list.

## Headless CI Mode

```bash
cargo run -- run --prompt "Explain Raft Pre-Vote" --json > benchmark.json
```

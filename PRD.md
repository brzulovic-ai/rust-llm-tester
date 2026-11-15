# Product Requirements Document (PRD)
# BenchForge — LLM Multi-Tester & Benchmark Workbench (Web + Rust TUI)

## 1. Executive Summary
**BenchForge** is a high-performance, developer-first benchmarking and prompt engineering suite designed for comparing, analyzing, and stress-testing Large Language Models across OpenAI-compatible APIs, Ollama, vLLM, LM Studio, Groq Cloud, and LiteLLM proxies.

The platform ships two synchronized interfaces backed by compatible execution semantics and TOML configuration:
- **Web Workbench**: A React 19 + Vite + Express + TypeScript workbench featuring live SSE streaming, multi-view analysis (Split, Cards, Network Waterfall, Token Diff, XY Capability Graph), browser/Supabase persistence, and TOML export.
- **Rust TUI (`benchforge-tui`)**: A terminal-native `ratatui` + `tokio` + `reqwest` client and headless CI runner featuring full TOML/env/CLI configuration management, live provider model discovery and aggregation, automatic config backups, keyboard-driven sorting/filtering, and local history/JSON/CSV exports.

---

## 2. Target Audience & Core Use Cases
- **AI Engineers & Researchers**: Benchmarking inference latency, Time-to-First-Byte (TTFB), throughput (`tok/s`), and response fidelity across heterogeneous local and cloud models simultaneously.
- **Prompt & Agent Engineers**: Evaluating system personas, constraint adherence, tool-calling schemas, web search query planning/grounding, Model Context Protocol (MCP) handlers, and prompt injection defenses.
- **DevOps & Engineering Teams**: Running repeatable benchmarks locally or in CI/CD pipelines (`benchforge run --json`), persisting runs to PostgreSQL/Supabase, sharing reproducible snapshots, and containerizing proxy stacks with LiteLLM and Docker Compose.

---

## 3. Supported Providers & Proxy Architecture
| Provider | Kind | Default Base URL | Auth Env Var | Default / Highlight Models |
| --- | --- | --- | --- | --- |
| **Ollama Local** | `ollama` | `http://localhost:11434/v1` | Optional | `llama3.2:latest`, `qwen2.5-coder:7b` |
| **LM Studio** | `lmstudio` | `http://localhost:1234/v1` | Optional | `local-model` |
| **Groq Cloud** | `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `qwen/qwen3-32b`, `openai/gpt-oss-120b`, `moonshotai/kimi-k2-instruct` |
| **LiteLLM Proxy** | `litellm` | `http://localhost:4100/v1` | `LITELLM_API_KEY` | `gpt-4o-mini`, `claude-3-7-sonnet`, `gemini/gemini-2.5-flash`, `deepseek/deepseek-chat` |
| **OpenAI API** | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4o-mini`, `gpt-4.1-mini` |

- Supports live `GET {base_url}/models` discovery across both OpenAI (`data[].id`) and Ollama (`models[].id | name`) schemas, Bearer authentication via environment variables, and custom headers without storing plaintext secrets in TOML.

---

## 4. Functional Requirements — Web Workbench

### 4.1 Multi-Model Inference & Execution Engine
- **Sequential & Parallel Execution**: Sequential queue or parallel worker pool (`1–10` threads).
- **SSE Streaming**: Real-time Server-Sent Events token streaming with live TTFB timing and `tokens/sec` metrics.
- **Timeout & Retry Control**: Configurable request timeouts (`10–600s`, default `300s`), batch abort, and one-click bulk retry for failed/idle targets.
- **Server-Side Proxy Routes**: Express middleware (`/api/*`) avoids exposing credentials unnecessarily and eliminates browser CORS friction where applicable.

### 4.2 Prompt Engineering & System Prompt Layer
- **System Prompt Injection**: Enable/disable directives globally ("all models") or per-target ("specific models") with built-in personas (`Concise Expert`, `Deep Analyst`, `Code Architect`).
- **Prompt Test Suites**: Curated test batteries including *Nerdy Kings (18)* systems/reasoning benchmarks, *Classic Benchmarks*, and *HTML Games Generators*.

### 4.3 Data Visualization & Comparison
- **Split & Card Views**: Live streaming output, Markdown rendering, raw output inspection, embedded HTML preview frames, and Web Speech TTS playback.
- **DevTools Network Waterfall**: Sub-millisecond phase breakdown (`Queue`, `Request`, `TTFB`, `Download`, `Total Duration`).
- **Token-Level Diff Compare**: Side-by-side baseline vs. candidate diff highlighting insertions, deletions, and similarity percentage.
- **XY Capability Scatter Graph**: Interactive TTFB latency vs. throughput/token scatter plot with hover tooltips and zoom controls.

### 4.4 Persistence, Sync, & UI/UX
- **Local & Cloud Persistence**: Browser `localStorage` session history (last 50 runs) and optional Supabase PostgreSQL auto-sync with connection diagnostics.
- **Exports & Sharing**: JSON bundle export, CSV export, URL hash share links, and a **Rust TUI & TOML Export Modal** synced with live app state.
- **Themes & Layout**: `Light`, `Dark`, `Sepia Light`, `Sepia Dark`, and `Greenish Sepia` themes, resizable accordion sidebar (Prompt expanded, Configuration & History collapsed by default).

---

## 5. Functional Requirements — Rust TUI (`benchforge-tui`)

### 5.1 Configuration, Backup, & Discovery
- **Precedence Chain**: `--config <path>` → `./benchforge.toml` → OS user config (`~/.config/benchforge/config.toml`) → built-in defaults, overridden by `BENCHFORGE_THEME`, `BENCHFORGE_CONCURRENCY`, and `BENCHFORGE_TIMEOUT`.
- **Safe Secret Resolution**: Resolves API keys from environment variables referenced in `api_key_env` (e.g., `GROQ_API_KEY`, `LITELLM_API_KEY`, `OPENAI_API_KEY`).
- **Automatic Config Backup on Save**: Every overwrite via `save_with_backup` (TUI `s`, auto-save on model discovery, CLI `config refresh`) creates `<config>.bak` beforehand (`make tui-restore` recovers the backup).
- **Provider Refresh & TOML Aggregation**: Discover models via `d` (selected provider), `D` (all providers), or `cargo run -- config refresh` (`make tui-refresh`), deduplicating and writing newly discovered models and targets directly to `benchforge.toml`.

### 5.2 Multi-Tab Terminal Interface (`1`–`6`)
- **`1:Prompt` (Suites & Live Preview)**:
  - Scrollable suite catalog (`ListState`) including *Nerdy Kings (18)*, *Classic Benchmarks*, *HTML Games Generators*, and the **Tools, Web Search & MCP** battery (`tm-01`–`tm-08`: strict tool schemas, multi-tool orchestration, web search query planning & grounded synthesis, MCP server JSON-RPC handlers, multi-MCP routers, indirect prompt injection defense, and parallel read/write barriers).
  - Split right column displaying **Active Prompt** (top, editable via `i`) and live **Suite Preview** (bottom, updating continuously on `↑`/`↓` before loading with `Enter`/`Space`).
- **`2:Responses`**:
  - Stateful auto-scrolling **Targets** list (`ListState`) tracking selection accurately across large model sets, paired with wrapped output pane (`PgUp`/`PgDn` or `J`/`K` independent scrolling) and live `TTFB`, `tok/s`, and token metrics.
- **`3:Waterfall`**:
  - Sortable DevTools waterfall table (`TableState`) with keyboard sorting across `Config Order`, `Model`, `Status`, `Queue`, `Request`, `TTFB`, `Download`, `Total`, and `Speed` (`o`/`←`/`→` to switch column, `O`/`v`/`Space` to invert Asc/Desc).
- **`4:Diff` & `5:XY Graph`**:
  - Myers token diff viewer (`a`/`b` selectors) and terminal scatter chart (`TTFB ms` vs `tok/s`).
- **`6:Config`**:
  - Left pane for execution mode (`m`), concurrency (`+/-`), timeout (`[/]`), SSE toggle (`v`), system prompt/persona (`p`/`P`), theme (`t`), provider key status, and Supabase summary.
  - Right column split vertically into:
    1. **Target Providers**: Shows `[x]`/`[~]`/`[ ]` and `(enabled/total)` counts; `Space`/`Enter` rapidly enables or disables all models for a provider; `d`/`D` refreshes models.
    2. **Model Filter Textbox**: Focus via `/`, `f`, or `Shift+Tab` to filter models live across model name, provider ID, and provider name; supports `Ctrl+D` (deselect matches), `Ctrl+A` (select matches), `Ctrl+U` (clear filter), and `Esc` (exit).
    3. **Target Models**: Stateful scrollable list reachable via `Shift+Tab`, supporting per-model `Space`/`Enter` toggles plus `u` (deselect all filtered models) and `a` (select all filtered models).

### 5.3 Headless CLI Mode
- `benchforge init [--force]` — Scaffold `benchforge.toml`.
- `benchforge config validate | show | refresh` — Validate configuration, inspect merged TOML, or discover & aggregate provider models into TOML.
- `benchforge run --prompt "<text>" [--json]` — Execute non-interactive CI/CD benchmark batches.

---

## 6. Architecture & Repository Structure
- `server.ts`, `src/` — Express server + React 19 TypeScript Web Workbench, Vitest test suites (`src/__tests__/`).
- `rust-tui/src/`:
  - `main.rs` — CLI (`clap`) subcommands & terminal event loop.
  - `config.rs` — TOML persistence, `.bak` backup creation, env overrides, provider model aggregation, validation.
  - `engine.rs` — Async `reqwest` streaming benchmark runner, phase timings, error advice, `/models` discovery.
  - `suites.rs` — Built-in personas and prompt suites (*Nerdy Kings*, *Classic*, *HTML*, *Tools, Web Search & MCP*).
  - `app.rs` — TUI state machine, filtering, waterfall sorting, keybindings, export/sync triggers.
  - `ui.rs` — 5-theme `ratatui` renderer with stateful list/table scrolling.
  - `diff.rs`, `export.rs` — Token diffing, local JSON history, JSON/CSV bundle export, Supabase REST sync.
- `Makefile`, `Dockerfile`, `rust-tui/Dockerfile`, `docker-compose.yml`, `litellm.config.yaml` — Build orchestration and containerized deployment.

---

## 7. Build, Quality, & Deployment
- **Web Checks**: `make web-lint` (`tsc --noEmit`), `make web-test` (Vitest 58+ unit & component tests), `make web-build` (Vite production bundle).
- **Rust Checks**: `make tui-test` (Cargo unit tests covering TOML roundtrip/backups, diffing, model discovery aggregation, and suites), `make tui-clippy` (`-D warnings`), `make tui-fmt-check`.
- **Unified Gate**: `make check` runs all Web + Rust checks together.
- **Containers**: `make up` launches the Web Workbench (`:3000`); `make up-litellm` adds LiteLLM Proxy (`:4100`); `make tui-docker` runs interactive `benchforge-tui`.

---

## 8. Non-Functional Requirements & Future Roadmap
- **Reliability & Security**: Sub-200ms UI responsiveness; zero plaintext secret requirements in checked-in configs; pre-save `.bak` config protection; actionable HTTP/timeout remediation messages.
- **Future Roadmap**:
  - Live tool-calling / MCP JSON-RPC execution harness directly from `benchforge-tui` and the Web Workbench.
  - Automated regression threshold checks (`--fail-on-regression`) comparing headless `--json` runs against saved baselines.
  - Cost-per-1M-token pricing tables and per-run spend analytics.

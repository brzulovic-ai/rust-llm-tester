.PHONY: help web-install web-dev web-build web-start web-test web-lint \
	tui-init tui-validate tui-show tui-refresh tui-restore tui-bench \
	tui-build tui-run tui-test tui-clippy tui-fmt tui-fmt-check \
	up up-litellm down logs tui-docker build-images check clean

RUST_DIR := rust-tui
CONFIG_FILE ?= benchforge.toml
ABS_CONFIG := $(abspath $(CONFIG_FILE))
PROMPT ?= Explain Raft Pre-Vote and ReadIndex in 5 concise bullet points.

help:
	@echo "BenchForge — Web Workbench & Rust TUI Targets"
	@echo ""
	@echo "Web Workbench:"
	@echo "  make web-install    Install Node.js dependencies"
	@echo "  make web-dev        Run Express + Vite dev server on :3000"
	@echo "  make web-build      Build Vite production bundle"
	@echo "  make web-start      Run production server on :3000"
	@echo "  make web-test       Run Vitest unit & component tests"
	@echo "  make web-lint       Run TypeScript type check"
	@echo ""
	@echo "Rust TUI (benchforge-tui):"
	@echo "  make tui-init       Scaffold $(CONFIG_FILE) from defaults"
	@echo "  make tui-validate   Validate TOML config & API key environment variables"
	@echo "  make tui-show       Print effective merged TOML configuration"
	@echo "  make tui-refresh    Discover provider models and aggregate into TOML (.bak on overwrite)"
	@echo "  make tui-restore    Restore $(CONFIG_FILE) from $(CONFIG_FILE).bak"
	@echo "  make tui-bench      Run headless JSON benchmark (override PROMPT=...)"
	@echo "  make tui-build      Build release binary in rust-tui/target/release"
	@echo "  make tui-run        Launch interactive Rust TUI"
	@echo "  make tui-test       Run Cargo unit tests"
	@echo "  make tui-clippy     Run cargo clippy with -D warnings"
	@echo "  make tui-fmt        Format Rust sources with cargo fmt"
	@echo "  make tui-fmt-check  Verify Rust formatting without modifying files"
	@echo ""
	@echo "Docker & Compose:"
	@echo "  make up             Start Web Workbench (:3000) via Docker Compose"
	@echo "  make up-litellm     Start Web Workbench (:3000) + LiteLLM Proxy (:4100)"
	@echo "  make tui-docker     Run interactive Rust TUI container"
	@echo "  make build-images   Build all Docker images"
	@echo "  make down           Stop all Docker Compose services"
	@echo "  make logs           Tail Docker Compose logs"
	@echo "  make check          Run web lint/test/build + Rust test/clippy/fmt-check"

web-install:
	npm install

web-dev:
	npm run dev

web-build:
	npm run build

web-start:
	NODE_ENV=production npm start

web-test:
	npm test

web-lint:
	npm run lint

tui-init:
	@if [ ! -f "$(ABS_CONFIG)" ]; then cp $(RUST_DIR)/benchforge.toml.example "$(ABS_CONFIG)"; echo "Created $(ABS_CONFIG)"; else echo "$(ABS_CONFIG) already exists"; fi

tui-validate:
	cd $(RUST_DIR) && cargo run -- --config "$(ABS_CONFIG)" config validate

tui-show:
	cd $(RUST_DIR) && cargo run -- --config "$(ABS_CONFIG)" config show

tui-refresh:
	cd $(RUST_DIR) && cargo run -- --config "$(ABS_CONFIG)" config refresh

tui-restore:
	@if [ -f "$(ABS_CONFIG).bak" ]; then cp "$(ABS_CONFIG).bak" "$(ABS_CONFIG)"; echo "Restored $(ABS_CONFIG) from $(ABS_CONFIG).bak"; else echo "No backup found at $(ABS_CONFIG).bak"; exit 1; fi

tui-bench:
	cd $(RUST_DIR) && cargo run -- --config "$(ABS_CONFIG)" run --prompt "$(PROMPT)" --json

tui-build:
	cd $(RUST_DIR) && cargo build --release

tui-run:
	cd $(RUST_DIR) && cargo run --release -- --config "$(ABS_CONFIG)"

tui-test:
	cd $(RUST_DIR) && cargo test

tui-clippy:
	cd $(RUST_DIR) && cargo clippy --all-targets -- -D warnings

tui-fmt:
	cd $(RUST_DIR) && cargo fmt --all

tui-fmt-check:
	cd $(RUST_DIR) && cargo fmt --all -- --check

up:
	docker compose up -d --build workbench

up-litellm:
	docker compose --profile litellm up -d --build

down:
	docker compose --profile litellm down

logs:
	docker compose --profile litellm logs -f

tui-docker:
	docker compose run --rm benchforge-tui

build-images:
	docker compose --profile litellm build

check: web-lint web-test web-build tui-test tui-clippy tui-fmt-check

clean:
	npm run clean
	cd $(RUST_DIR) && cargo clean || true

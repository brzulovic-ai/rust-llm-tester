.PHONY: help web-install web-dev web-build web-start web-test web-lint \
	tui-init tui-validate tui-build tui-run tui-test tui-clippy tui-fmt \
	up up-litellm down logs tui-docker build-images check clean

RUST_DIR := rust-tui
CONFIG_FILE ?= benchforge.toml

help:
	@echo "BenchForge — Web Workbench & Rust TUI Targets"
	@echo ""
	@echo "Web Workbench:"
	@echo "  make web-install   Install Node.js dependencies"
	@echo "  make web-dev       Run Express + Vite dev server on :3000"
	@echo "  make web-build     Build Vite production bundle"
	@echo "  make web-start     Run production server on :3000"
	@echo "  make web-test      Run Vitest unit & component tests"
	@echo "  make web-lint      Run TypeScript type check"
	@echo ""
	@echo "Rust TUI (benchforge-tui):"
	@echo "  make tui-init      Scaffold ./benchforge.toml from defaults"
	@echo "  make tui-validate  Validate config & API key environment variables"
	@echo "  make tui-build     Build release binary in rust-tui/target/release"
	@echo "  make tui-run       Launch interactive Rust TUI"
	@echo "  make tui-test      Run Cargo unit tests"
	@echo "  make tui-clippy    Run cargo clippy with -D warnings"
	@echo "  make tui-fmt       Format Rust sources with cargo fmt"
	@echo ""
	@echo "Docker & Compose:"
	@echo "  make up            Start Web Workbench (:3000) via Docker Compose"
	@echo "  make up-litellm    Start Web Workbench (:3000) + LiteLLM Proxy (:4100)"
	@echo "  make tui-docker    Run interactive Rust TUI container"
	@echo "  make build-images  Build all Docker images"
	@echo "  make down          Stop all Docker Compose services"
	@echo "  make logs          Tail Docker Compose logs"
	@echo "  make check         Run web lint/test/build + Rust test/clippy"

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
	@if [ ! -f "$(CONFIG_FILE)" ]; then cp $(RUST_DIR)/benchforge.toml.example $(CONFIG_FILE); echo "Created $(CONFIG_FILE)"; else echo "$(CONFIG_FILE) already exists"; fi

tui-validate:
	cd $(RUST_DIR) && cargo run -- --config ../$(CONFIG_FILE) config validate

tui-build:
	cd $(RUST_DIR) && cargo build --release

tui-run:
	cd $(RUST_DIR) && cargo run --release -- --config ../$(CONFIG_FILE)

tui-test:
	cd $(RUST_DIR) && cargo test

tui-clippy:
	cd $(RUST_DIR) && cargo clippy --all-targets -- -D warnings

tui-fmt:
	cd $(RUST_DIR) && cargo fmt --all

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

check: web-lint web-test web-build tui-test tui-clippy

clean:
	npm run clean
	cd $(RUST_DIR) && cargo clean || true

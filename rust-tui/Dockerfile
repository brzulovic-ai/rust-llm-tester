FROM rust:1.85-bookworm AS builder

WORKDIR /usr/src/benchforge
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /usr/src/benchforge/target/release/benchforge /usr/local/bin/benchforge
COPY benchforge.toml.example /app/benchforge.toml.example

ENTRYPOINT ["benchforge"]
CMD ["--config", "/app/benchforge.toml"]

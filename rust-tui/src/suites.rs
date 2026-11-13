pub struct SystemPersona {
    pub id: &'static str,
    pub name: &'static str,
    pub prompt: &'static str,
}

pub struct PromptSuiteItem {
    pub id: &'static str,
    pub suite: &'static str,
    pub title: &'static str,
    pub category: &'static str,
    pub prompt: &'static str,
}

pub const SYSTEM_PERSONAS: &[SystemPersona] = &[
    SystemPersona {
        id: "concise-expert",
        name: "Concise Expert",
        prompt: "You are a principal systems engineer. Respond with crisp, authoritative precision. Omit conversational preambles, cite concrete complexity bounds or edge cases, and keep formatting scannable.",
    },
    SystemPersona {
        id: "deep-analyst",
        name: "Deep Analyst",
        prompt: "You are a rigorous analytical researcher. Decompose the problem from first principles, explicitly verify assumptions, explore failure modes and trade-offs, and conclude with a structured synthesis.",
    },
    SystemPersona {
        id: "code-architect",
        name: "Code Architect",
        prompt: "You are a staff software architect. Produce clean, idiomatic, production-grade code with explicit error handling, strong typing, and clear architectural rationale.",
    },
];

pub const PROMPT_SUITES: &[PromptSuiteItem] = &[
    PromptSuiteItem {
        id: "nk-01",
        suite: "Nerdy Kings (18)",
        title: "01. Lock-Free Ring Buffer",
        category: "Concurrency",
        prompt: "Design a single-producer single-consumer (SPSC) wait-free ring buffer. Explain the exact memory ordering semantics (Acquire/Release vs SeqCst) needed to prevent false sharing and store-load reordering, then implement a clean version.",
    },
    PromptSuiteItem {
        id: "nk-02",
        suite: "Nerdy Kings (18)",
        title: "02. Raft Split-Brain Edge Case",
        category: "Distributed Systems",
        prompt: "Walk through a scenario in Raft consensus where a partitioned leader still believes it holds leadership. How does Pre-Vote plus ReadIndex / leader lease prevent stale linearizable reads without hurting availability?",
    },
    PromptSuiteItem {
        id: "nk-03",
        suite: "Nerdy Kings (18)",
        title: "03. SIMD UTF-8 Validation",
        category: "Low-Level Systems",
        prompt: "Explain how branchless SIMD algorithms validate UTF-8 byte sequences at multi-gigabyte-per-second throughput. Detail the bitmask checks for multi-byte continuation bytes, overlong encodings, and UTF-16 surrogates.",
    },
    PromptSuiteItem {
        id: "nk-04",
        suite: "Nerdy Kings (18)",
        title: "04. Zero-Alloc JSON Tokenizer",
        category: "Parsers",
        prompt: "Write a streaming JSON structural tokenizer that operates on byte slices without allocating intermediate strings per token, tracking nested state via a bit-packed stack.",
    },
    PromptSuiteItem {
        id: "nk-05",
        suite: "Nerdy Kings (18)",
        title: "05. B+ Tree vs LSM Write Amp",
        category: "Storage Engines",
        prompt: "Compare write amplification, read amplification, and space amplification between a slotted-page B+ Tree and a leveled LSM-Tree under a 90% point-update, 10% range-scan workload on NVMe SSDs.",
    },
    PromptSuiteItem {
        id: "nk-06",
        suite: "Nerdy Kings (18)",
        title: "06. Type-Level State Machine",
        category: "Type Theory",
        prompt: "Implement a compile-time checked HTTP request builder using phantom type parameters where .send() cannot be invoked until .method() and .url() have both been called.",
    },
    PromptSuiteItem {
        id: "nk-07",
        suite: "Nerdy Kings (18)",
        title: "07. Consistent Hashing Bounded",
        category: "Algorithms",
        prompt: "Implement consistent hashing with bounded loads (Mirrokni et al.), guaranteeing no shard exceeds (1 + epsilon) * avgLoad while preserving minimal key movement on node churn.",
    },
    PromptSuiteItem {
        id: "nk-08",
        suite: "Nerdy Kings (18)",
        title: "08. KV-Cache PagedAttention Math",
        category: "ML Systems",
        prompt: "Calculate the exact GPU VRAM footprint of an autoregressive transformer KV-cache for 32k context with GQA (8 KV heads, 64 query heads, head_dim=128, 64 layers, FP16), and explain how PagedAttention eliminates internal fragmentation.",
    },
    PromptSuiteItem {
        id: "nk-09",
        suite: "Nerdy Kings (18)",
        title: "09. CRDT Fractional Indexing",
        category: "Collab Editing",
        prompt: "Why do naive floating-point fractional indices fail in collaborative rich-text editors under concurrent insertions, and how does Replicated Growable Array (RGA) solve interleaving anomalies?",
    },
    PromptSuiteItem {
        id: "nk-10",
        suite: "Nerdy Kings (18)",
        title: "10. Byzantine 3f+1 Bound",
        category: "Formal Reasoning",
        prompt: "Prove rigorously why asynchronous or unauthenticated synchronous consensus requires at least 3f + 1 replicas to tolerate f Byzantine faults, illustrating the n=3, f=1 counterexample.",
    },
    PromptSuiteItem {
        id: "nk-11",
        suite: "Nerdy Kings (18)",
        title: "11. Postgres MVCC Vacuum Bloat",
        category: "Databases",
        prompt: "A production PostgreSQL table suffers 40x index bloat despite autovacuum running every minute. List the top 4 root causes and the exact diagnostic SQL queries.",
    },
    PromptSuiteItem {
        id: "nk-12",
        suite: "Nerdy Kings (18)",
        title: "12. Myers Diff O(ND)",
        category: "Algorithms",
        prompt: "Explain Eugene Myers' O(ND) diff algorithm and its linear-space divide-and-conquer refinement with a clean token-sequence implementation.",
    },
    PromptSuiteItem {
        id: "nk-13",
        suite: "Nerdy Kings (18)",
        title: "13. Kahan Summation Trap",
        category: "Numerical",
        prompt: "Why can aggressive compiler -ffast-math or FMA contraction silently destroy Kahan compensated summation? Show the exact algebraic cancellation that gets optimized away.",
    },
    PromptSuiteItem {
        id: "nk-14",
        suite: "Nerdy Kings (18)",
        title: "14. TLS 1.3 0-RTT Replay",
        category: "Security",
        prompt: "Analyze the security boundary of TLS 1.3 0-RTT early data and explain why anti-replay strike registers or single-use tickets are required.",
    },
    PromptSuiteItem {
        id: "nk-15",
        suite: "Nerdy Kings (18)",
        title: "15. HyperLogLog Harmonic Mean",
        category: "Probabilistic",
        prompt: "Derive why HyperLogLog uses the harmonic mean instead of the arithmetic or geometric mean across m registers to estimate cardinality.",
    },
    PromptSuiteItem {
        id: "nk-16",
        suite: "Nerdy Kings (18)",
        title: "16. Speculative Decoding Proof",
        category: "ML Inference",
        prompt: "Prove mathematically that speculative decoding with rejection sampling preserves the exact target model probability distribution p(x) regardless of the draft model q(x).",
    },
    PromptSuiteItem {
        id: "nk-17",
        suite: "Nerdy Kings (18)",
        title: "17. WebGPU SGEMM Tiling",
        category: "GPU Compute",
        prompt: "Write a WGSL compute shader outline for tiled SGEMM using workgroup shared memory to maximize arithmetic intensity and avoid bank conflicts.",
    },
    PromptSuiteItem {
        id: "nk-18",
        suite: "Nerdy Kings (18)",
        title: "18. Async Cache Race Condition",
        category: "Debugging",
        prompt: "Given an async cache getOrCompute(key, fn) storing in-flight futures, identify three production race/poisoning bugs and write the fixed version.",
    },
    PromptSuiteItem {
        id: "cb-01",
        suite: "Classic Benchmarks",
        title: "Logic Constraint Grid",
        category: "Reasoning",
        prompt: "Five servers (Alpha, Beta, Gamma, Delta, Epsilon) run five distinct services (Auth, Billing, Search, Queue, Storage) in five racks (1-5). Alpha is immediately left of Billing. Gamma is in Rack 3 and runs Search. Queue is in an even rack, not adjacent to Auth. Delta is in Rack 5 and does not run Storage. Beta runs Auth. Determine the exact mapping.",
    },
    PromptSuiteItem {
        id: "cb-02",
        suite: "Classic Benchmarks",
        title: "Strict JSON Extraction",
        category: "Structured Output",
        prompt: "Extract entities, dates, monetary values, and actions from: 'On November 14, 2026, Meridian Robotics approved a $420,000 USD hardware grant for Elena Vance to deploy 12 lidar units in Munich before January 10, 2027.' Return strict JSON only.",
    },
    PromptSuiteItem {
        id: "hg-01",
        suite: "HTML Games Generators",
        title: "Single-File Retro Breakout",
        category: "Canvas Game",
        prompt: "Create a complete, single-file HTML5 Canvas Breakout arcade game with paddle physics, multi-hit bricks, score counter, and restart button inside a single ```html block.",
    },
];

pub fn lookup_persona(id: &str) -> Option<&'static SystemPersona> {
    SYSTEM_PERSONAS.iter().find(|p| p.id == id)
}

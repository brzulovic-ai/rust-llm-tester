export interface SystemPersona {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface PromptSuiteItem {
  id: string;
  suite: 'nerdy-kings' | 'html-games' | 'classic-benchmarks';
  suiteLabel: string;
  index: number;
  title: string;
  category: string;
  prompt: string;
  recommendedSystemPrompt?: string;
}

export const SYSTEM_PERSONAS: SystemPersona[] = [
  {
    id: 'concise-expert',
    name: 'Concise Expert',
    description: 'Direct, high-signal technical answers without filler.',
    prompt:
      'You are a principal systems engineer. Respond with crisp, authoritative precision. Omit conversational preambles, cite concrete complexity bounds or edge cases, and keep formatting scannable.',
  },
  {
    id: 'deep-analyst',
    name: 'Deep Analyst',
    description: 'First-principles decomposition with step-by-step verification.',
    prompt:
      'You are a rigorous analytical researcher. Decompose the problem from first principles, explicitly verify assumptions, explore failure modes and trade-offs, and conclude with a structured synthesis.',
  },
  {
    id: 'code-architect',
    name: 'Code Architect',
    description: 'Production-ready implementations with clean types and invariants.',
    prompt:
      'You are a staff software architect. Produce clean, idiomatic, production-grade code with explicit error handling, strong typing, and clear architectural rationale.',
  },
];

export const PROMPT_SUITES: PromptSuiteItem[] = [
  // Nerdy Kings Test Battery (18 advanced reasoning and coding prompts)
  {
    id: 'nk-01',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 1,
    title: 'Lock-Free Ring Buffer in Rust/TS',
    category: 'Concurrency',
    prompt:
      'Design a single-producer single-consumer (SPSC) wait-free ring buffer. Explain the exact memory ordering semantics (Acquire/Release vs SeqCst) needed to prevent false sharing and store-load reordering, then implement a clean version.',
  },
  {
    id: 'nk-02',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 2,
    title: 'Raft Split-Brain Edge Case',
    category: 'Distributed Systems',
    prompt:
      'Walk through a scenario in Raft consensus where a partitioned leader still believes it holds leadership. How does Pre-Vote plus ReadIndex / leader lease prevent stale linearizable reads without hurting availability?',
  },
  {
    id: 'nk-03',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 3,
    title: 'SIMD UTF-8 Validation',
    category: 'Low-Level Systems',
    prompt:
      'Explain how branchless SIMD algorithms validate UTF-8 byte sequences at multi-gigabyte-per-second throughput. Detail the bitmask checks for multi-byte continuation bytes, overlong encodings, and UTF-16 surrogates.',
  },
  {
    id: 'nk-04',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 4,
    title: 'Zero-Allocation JSON Tokenizer',
    category: 'Compilers & Parsers',
    prompt:
      'Write a TypeScript streaming JSON structural tokenizer that operates on Uint8Array slices without allocating intermediate strings per token, tracking nested state via a bit-packed stack.',
  },
  {
    id: 'nk-05',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 5,
    title: 'B+ Tree vs LSM-Tree Write Amplification',
    category: 'Storage Engines',
    prompt:
      'Compare write amplification, read amplification, and space amplification between a slotted-page B+ Tree and a leveled LSM-Tree under a 90% point-update, 10% range-scan workload on NVMe SSDs.',
  },
  {
    id: 'nk-06',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 6,
    title: 'Type-Level State Machine',
    category: 'Type Theory',
    prompt:
      'Implement a compile-time checked HTTP request builder in TypeScript where `.send()` cannot be invoked until `.method()` and `.url()` have both been called, using phantom type parameters.',
  },
  {
    id: 'nk-07',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 7,
    title: 'Consistent Hashing with Bounded Loads',
    category: 'Algorithms',
    prompt:
      'Implement consistent hashing with bounded loads (Mirrokni et al.) in TypeScript, guaranteeing no shard exceeds `(1 + epsilon) * avgLoad` while preserving minimal key movement on node churn.',
  },
  {
    id: 'nk-08',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 8,
    title: 'KV-Cache PagedAttention Math',
    category: 'ML Systems',
    prompt:
      'Calculate the exact GPU VRAM footprint of an autoregressive transformer KV-cache for 32k context with GQA (8 KV heads, 64 query heads, head_dim=128, 64 layers, FP16), and explain how PagedAttention eliminates internal fragmentation.',
  },
  {
    id: 'nk-09',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 9,
    title: 'CRDT Fractional Indexing & RGA',
    category: 'Collaborative Editing',
    prompt:
      'Why do naive floating-point fractional indices fail in collaborative rich-text editors under concurrent insertions, and how does Replicated Growable Array (RGA) solve interleaving anomalies?',
  },
  {
    id: 'nk-10',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 10,
    title: 'Byzantine Generals Minimum Bound',
    category: 'Formal Reasoning',
    prompt:
      'Prove rigorously why asynchronous or unauthenticated synchronous consensus requires at least `3f + 1` replicas to tolerate `f` Byzantine faults, illustrating the `n=3, f=1` counterexample.',
  },
  {
    id: 'nk-11',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 11,
    title: 'PostgreSQL MVCC Vacuum Bloat Diagnosis',
    category: 'Databases',
    prompt:
      'A production PostgreSQL table suffers 40x index bloat despite autovacuum running every minute. List the top 4 root causes (long-running snapshots, replication slots, prepared xacts, hot-update failures) and the exact diagnostic SQL queries.',
  },
  {
    id: 'nk-12',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 12,
    title: 'Myers Diff Algorithm Optimization',
    category: 'Algorithms',
    prompt:
      'Explain Eugene Myers’ O(ND) diff algorithm and its linear-space divide-and-conquer refinement. Provide a clean, tested TypeScript implementation for token sequences.',
  },
  {
    id: 'nk-13',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 13,
    title: 'Floating-Point Kahan Summation Trap',
    category: 'Numerical Methods',
    prompt:
      'Why can aggressive compiler `-ffast-math` or FMA contraction silently destroy Kahan compensated summation? Show the exact algebraic cancellation that gets optimized away and how to guard against it.',
  },
  {
    id: 'nk-14',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 14,
    title: 'TLS 1.3 0-RTT Replay Vulnerability',
    category: 'Security',
    prompt:
      'Analyze the security boundary of TLS 1.3 0-RTT early data. Why must idempotency checks alone not be trusted at the application layer without anti-replay strike registers or single-use tickets?',
  },
  {
    id: 'nk-15',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 15,
    title: 'HyperLogLog Harmonic Mean Bias',
    category: 'Probabilistic DS',
    prompt:
      'Derive why HyperLogLog uses the harmonic mean instead of the arithmetic or geometric mean across `m` registers to estimate cardinality, and how small-range linear counting corrects bias.',
  },
  {
    id: 'nk-16',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 16,
    title: 'Speculative Decoding Acceptance Proof',
    category: 'ML Inference',
    prompt:
      'Prove mathematically that speculative decoding with rejection sampling preserves the exact target model probability distribution `p(x)` regardless of how inaccurate the draft model `q(x)` is.',
  },
  {
    id: 'nk-17',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 17,
    title: 'WebGPU Matrix Multiply Tiling',
    category: 'GPU Compute',
    prompt:
      'Write a WGSL compute shader outline for tiled SGEMM using workgroup shared memory (`var<workgroup>`) to maximize arithmetic intensity and avoid shared-memory bank conflicts.',
  },
  {
    id: 'nk-18',
    suite: 'nerdy-kings',
    suiteLabel: 'Nerdy Kings Test Battery',
    index: 18,
    title: 'Debugging a Subtle Async Race Condition',
    category: 'Debugging',
    prompt:
      'Given an async cache `getOrCompute(key, fn)` that stores in-flight Promises to deduplicate requests, identify three production bugs (unhandled rejection poisoning, stale eviction race, thundering herd on TTL expiry) and write the fixed TypeScript class.',
  },

  // HTML Games Generators
  {
    id: 'hg-01',
    suite: 'html-games',
    suiteLabel: 'HTML Games Generators',
    index: 1,
    title: 'Single-File Retro Breakout Arcade',
    category: 'Canvas Game',
    prompt:
      'Create a complete, single-file HTML5 Canvas Breakout arcade game with smooth paddle physics, ball spin angles, multi-hit brick tiers, score counter, lives, and restart button. Return only valid self-contained HTML inside a single ```html code block.',
  },
  {
    id: 'hg-02',
    suite: 'html-games',
    suiteLabel: 'HTML Games Generators',
    index: 2,
    title: 'Gravity Orbital Slingshot Puzzle',
    category: 'Physics Game',
    prompt:
      'Build a complete single-file HTML5 Canvas orbital slingshot game where the player drags to launch a probe around gravitational planets to hit a target beacon. Return a complete standalone ```html document with embedded CSS and JS.',
  },
  {
    id: 'hg-03',
    suite: 'html-games',
    suiteLabel: 'HTML Games Generators',
    index: 3,
    title: 'Conway Life & Glider Sandbox',
    category: 'Simulation',
    prompt:
      'Create a complete single-file HTML5 interactive Conway’s Game of Life simulator with click-to-draw cells, play/pause, step, speed slider, preset patterns (Glider Gun, Pulsar), and generation counter inside a single ```html block.',
  },
  {
    id: 'hg-04',
    suite: 'html-games',
    suiteLabel: 'HTML Games Generators',
    index: 4,
    title: 'Hexagonal Minesweeper Tactician',
    category: 'Puzzle Game',
    prompt:
      'Build a complete single-file HTML5 SVG/Canvas Minesweeper game with first-click safety, flood-fill reveal, right-click flags, timer, and mine counter. Output a self-contained ```html document.',
  },

  // Classic Benchmarks
  {
    id: 'cb-01',
    suite: 'classic-benchmarks',
    suiteLabel: 'Classic Benchmarks',
    index: 1,
    title: 'Multi-Step Logic & Constraint Grid',
    category: 'Reasoning',
    prompt:
      'Five servers (Alpha, Beta, Gamma, Delta, Epsilon) run five distinct services (Auth, Billing, Search, Queue, Storage) in five racks (1–5). 1) Alpha is immediately left of Billing. 2) Gamma is in Rack 3 and runs Search. 3) Queue is in an even rack, not adjacent to Auth. 4) Delta is in Rack 5 and does not run Storage. 5) Beta runs Auth. Determine the exact mapping and verify all 5 constraints.',
  },
  {
    id: 'cb-02',
    suite: 'classic-benchmarks',
    suiteLabel: 'Classic Benchmarks',
    index: 2,
    title: 'Strict JSON Schema Extraction',
    category: 'Structured Output',
    prompt:
      'Extract all entities, dates, monetary values, and action items from this snippet into valid JSON matching `{ "entities": string[], "dates": string[], "amounts": { "value": number, "currency": string }[], "actions": { "owner": string, "task": string }[] }` with zero markdown prose:\n\n"On November 14, 2026, Meridian Robotics approved a $420,000 USD hardware grant for Elena Vance to deploy 12 lidar units in Munich before January 10, 2027, while Marcus Chen audits the telemetry pipeline."',
  },
  {
    id: 'cb-03',
    suite: 'classic-benchmarks',
    suiteLabel: 'Classic Benchmarks',
    index: 3,
    title: 'HumanEval Interval Merge & Coverage',
    category: 'Coding',
    prompt:
      'Write a function `mergeAndMeasure(intervals: [number, number][]): { merged: [number, number][]; totalCoverage: number }` in TypeScript that merges overlapping or touching closed intervals and computes total covered length in O(n log n) time, handling empty inputs and negative coordinates.',
  },
  {
    id: 'cb-04',
    suite: 'classic-benchmarks',
    suiteLabel: 'Classic Benchmarks',
    index: 4,
    title: 'Technical Trade-Off Synthesis',
    category: 'Architecture',
    prompt:
      'Compare Server-Sent Events (SSE), WebSockets, and WebTransport for streaming LLM tokens to 50,000 concurrent browser clients behind Cloudflare/Nginx. Summarize multiplexing, proxy buffering pitfalls, reconnection ergonomics, and memory overhead in a concise markdown table.',
  },
];

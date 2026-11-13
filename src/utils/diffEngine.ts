export type DiffOpType = 'equal' | 'insert' | 'delete';

export interface DiffSegment {
  type: DiffOpType;
  value: string;
}

export interface DiffStats {
  insertions: number;
  deletions: number;
  unchanged: number;
  similarityPct: number;
}

/**
 * Tokenizes text preserving whitespace tokens so side-by-side rendering stays exact.
 */
export function tokenizeForDiff(text: string): string[] {
  if (!text) return [];
  return text.match(/\S+|\s+/g) ?? [];
}

/**
 * Computes token-level LCS diff between two model outputs.
 * Caps DP table size safely for huge outputs by falling back to line-level tokenization if needed.
 */
export function computeTokenDiff(textA: string, textB: string): {
  segments: DiffSegment[];
  stats: DiffStats;
} {
  let tokensA = tokenizeForDiff(textA);
  let tokensB = tokenizeForDiff(textB);

  // Guard memory for extremely long responses (> 2500 tokens each) by switching to line-level diff
  if (tokensA.length * tokensB.length > 2_500_000) {
    tokensA = textA.split(/(\r?\n)/);
    tokensB = textB.split(/(\r?\n)/);
  }

  const m = tokensA.length;
  const n = tokensB.length;

  if (m === 0 && n === 0) {
    return {
      segments: [],
      stats: { insertions: 0, deletions: 0, unchanged: 0, similarityPct: 100 },
    };
  }

  // Flat Int32Array DP matrix for fast LCS
  const cols = n + 1;
  const dp = new Int32Array((m + 1) * cols);

  for (let i = 1; i <= m; i++) {
    const rowOffset = i * cols;
    const prevRowOffset = (i - 1) * cols;
    const tokA = tokensA[i - 1];
    for (let j = 1; j <= n; j++) {
      if (tokA === tokensB[j - 1]) {
        dp[rowOffset + j] = dp[prevRowOffset + j - 1] + 1;
      } else {
        const up = dp[prevRowOffset + j];
        const left = dp[rowOffset + j - 1];
        dp[rowOffset + j] = up >= left ? up : left;
      }
    }
  }

  // Backtrack
  const reversed: DiffSegment[] = [];
  let i = m;
  let j = n;
  let insertions = 0;
  let deletions = 0;
  let unchanged = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensA[i - 1] === tokensB[j - 1]) {
      const val = tokensA[i - 1];
      if (val.trim().length > 0) unchanged++;
      reversed.push({ type: 'equal', value: val });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * cols + (j - 1)] >= dp[(i - 1) * cols + j])) {
      const val = tokensB[j - 1];
      if (val.trim().length > 0) insertions++;
      reversed.push({ type: 'insert', value: val });
      j--;
    } else {
      const val = tokensA[i - 1];
      if (val.trim().length > 0) deletions++;
      reversed.push({ type: 'delete', value: val });
      i--;
    }
  }

  reversed.reverse();

  // Merge adjacent segments of identical type for clean rendering
  const segments: DiffSegment[] = [];
  for (const seg of reversed) {
    const last = segments[segments.length - 1];
    if (last && last.type === seg.type) {
      last.value += seg.value;
    } else {
      segments.push({ ...seg });
    }
  }

  const denom = unchanged + Math.max(insertions, deletions);
  const similarityPct = denom === 0 ? 100 : Math.round((unchanged / denom) * 100);

  return {
    segments,
    stats: {
      insertions,
      deletions,
      unchanged,
      similarityPct,
    },
  };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffOp {
    Equal,
    Insert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSegment {
    pub op: DiffOp,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffStats {
    pub insertions: usize,
    pub deletions: usize,
    pub unchanged: usize,
    pub similarity_pct: usize,
}

pub fn tokenize_words(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_ws = false;

    for ch in input.chars() {
        let is_ws = ch.is_whitespace();
        if current.is_empty() {
            in_ws = is_ws;
            current.push(ch);
        } else if is_ws == in_ws {
            current.push(ch);
        } else {
            tokens.push(std::mem::take(&mut current));
            in_ws = is_ws;
            current.push(ch);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

pub fn compute_token_diff(a: &str, b: &str) -> (Vec<DiffSegment>, DiffStats) {
    let mut tok_a = tokenize_words(a);
    let mut tok_b = tokenize_words(b);

    // Fallback to line-level diff if product exceeds DP budget
    if tok_a.len().saturating_mul(tok_b.len()) > 1_500_000 {
        tok_a = a.split_inclusive('\n').map(|s| s.to_string()).collect();
        tok_b = b.split_inclusive('\n').map(|s| s.to_string()).collect();
    }

    let m = tok_a.len();
    let n = tok_b.len();

    if m == 0 && n == 0 {
        return (
            Vec::new(),
            DiffStats {
                insertions: 0,
                deletions: 0,
                unchanged: 0,
                similarity_pct: 100,
            },
        );
    }

    let cols = n + 1;
    let mut dp = vec![0u32; (m + 1) * cols];

    for i in 1..=m {
        for j in 1..=n {
            if tok_a[i - 1] == tok_b[j - 1] {
                dp[i * cols + j] = dp[(i - 1) * cols + (j - 1)] + 1;
            } else {
                let up = dp[(i - 1) * cols + j];
                let left = dp[i * cols + (j - 1)];
                dp[i * cols + j] = up.max(left);
            }
        }
    }

    let mut rev: Vec<DiffSegment> = Vec::new();
    let mut i = m;
    let mut j = n;
    let mut insertions = 0usize;
    let mut deletions = 0usize;
    let mut unchanged = 0usize;

    while i > 0 || j > 0 {
        if i > 0 && j > 0 && tok_a[i - 1] == tok_b[j - 1] {
            let val = &tok_a[i - 1];
            if !val.trim().is_empty() {
                unchanged += 1;
            }
            rev.push(DiffSegment {
                op: DiffOp::Equal,
                text: val.clone(),
            });
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i * cols + (j - 1)] >= dp[(i - 1) * cols + j]) {
            let val = &tok_b[j - 1];
            if !val.trim().is_empty() {
                insertions += 1;
            }
            rev.push(DiffSegment {
                op: DiffOp::Insert,
                text: val.clone(),
            });
            j -= 1;
        } else {
            let val = &tok_a[i - 1];
            if !val.trim().is_empty() {
                deletions += 1;
            }
            rev.push(DiffSegment {
                op: DiffOp::Delete,
                text: val.clone(),
            });
            i -= 1;
        }
    }

    rev.reverse();

    let mut merged: Vec<DiffSegment> = Vec::new();
    for seg in rev {
        if let Some(last) = merged.last_mut() {
            if last.op == seg.op {
                last.text.push_str(&seg.text);
                continue;
            }
        }
        merged.push(seg);
    }

    let denom = unchanged + insertions.max(deletions);
    let similarity_pct = if denom == 0 {
        100
    } else {
        (unchanged * 100) / denom
    };

    (
        merged,
        DiffStats {
            insertions,
            deletions,
            unchanged,
            similarity_pct,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_inputs_report_100_similarity() {
        let (_, stats) = compute_token_diff("raft pre-vote", "raft pre-vote");
        assert_eq!(stats.similarity_pct, 100);
        assert_eq!(stats.insertions, 0);
        assert_eq!(stats.deletions, 0);
    }

    #[test]
    fn detects_insertions_and_deletions() {
        let (segs, stats) = compute_token_diff("the quick brown fox", "the fast brown dog");
        assert_eq!(stats.deletions, 2);
        assert_eq!(stats.insertions, 2);
        assert_eq!(stats.unchanged, 2);
        assert!(segs.iter().any(|s| s.op == DiffOp::Delete && s.text.contains("quick")));
        assert!(segs.iter().any(|s| s.op == DiffOp::Insert && s.text.contains("fast")));
    }
}

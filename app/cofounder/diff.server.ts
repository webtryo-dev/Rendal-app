import type { DiffLine } from "./types";

// Line-level diff for the theme-edit approval modal. LCS-based, trimmed to
// changed hunks with a little context — merchants approve what they can read.

const MAX_LCS_LINES = 3000;
const CONTEXT_LINES = 2;
const MAX_OUTPUT_LINES = 400;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      { type: "ctx", text: `(file too large for a line diff — ${a.length} → ${b.length} lines)` },
      { type: "del", text: `— entire previous content (${a.length} lines) will be replaced —` },
      { type: "add", text: `— by the proposed content (${b.length} lines) —` },
    ];
  }

  // LCS table
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const full: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      full.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      full.push({ type: "del", text: a[i] });
      i++;
    } else {
      full.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) full.push({ type: "del", text: a[i++] });
  while (j < m) full.push({ type: "add", text: b[j++] });

  return trimToHunks(full);
}

/** Keep only changed lines plus a little surrounding context. */
function trimToHunks(full: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(full.length).fill(false);
  full.forEach((line, idx) => {
    if (line.type === "ctx") return;
    for (let k = Math.max(0, idx - CONTEXT_LINES); k <= Math.min(full.length - 1, idx + CONTEXT_LINES); k++) {
      keep[k] = true;
    }
  });

  const out: DiffLine[] = [];
  let skipping = false;
  for (let idx = 0; idx < full.length; idx++) {
    if (keep[idx]) {
      out.push(full[idx]);
      skipping = false;
    } else if (!skipping) {
      out.push({ type: "ctx", text: "…" });
      skipping = true;
    }
    if (out.length >= MAX_OUTPUT_LINES) {
      out.push({ type: "ctx", text: "… (diff truncated)" });
      break;
    }
  }
  return out;
}

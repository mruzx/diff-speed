// diff-speed: a faster drop-in for makefun-diff 1.0.0.
//
// The answer must be byte-identical to makefun-diff 1.0.0's for every input,
// including its exact choice between equally short edit scripts. This module
// re-implements that rule exactly (see the header of the house baseline's
// vendor/makefun-diff/index.js), but without its per-path objects:
//
//   - lines are interned to integer ids once per case, so every comparison
//     in the search is an int compare on typed arrays;
//   - the common prefix and suffix are trimmed on ids;
//   - Myers's greedy search stores, per (d, k), only the furthest x in one
//     flat array (V_d at offset d*d), with the same candidate rules as the
//     reference: a deletion is a candidate only while an old line is left,
//     an insertion only while a new line is left, and on a tie the deletion
//     wins; the snake is followed the same way;
//   - the edit script is recovered by backtracking the stored V tables with
//     the same choice rule, so the script is the reference's script.
//
// The V tables are kept in one scratch buffer reused across cases (never any
// case's data: every entry a search reads was written by that same search).
// Nothing is cached from one case to the next: every run() call interns its
// own lines and builds its own tables.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function splitLines(text) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const lines = new Array(parts.length);
  for (let i = 0; i < last; i++) lines[i] = parts[i] + '\n';
  if (parts[last] !== '') lines[last] = parts[last];
  else lines.length = last;
  return lines;
}

// Scratch V buffer, grown as the search deepens. V_d lives at offset d*d,
// entry k at d*d + k + d; (D+1)^2 entries are needed for a search of depth D.
// Uint16 while both texts are under 65535 lines (x never reaches the
// 0xFFFF sentinel then), Int32 otherwise. editRuns keeps the buffer in a
// local and stores it back for reuse across cases.
let V = null;
let Vcap = 0;
let Vwide = false;

/** The runs of the edit script of A into B: [[kind, count], ...], in order. */
function editRuns(A, B) {
  const n = A.length;
  const m = B.length;
  const wide = n >= 65535 || m >= 65535;
  const UNDEF = wide ? -1 : 0xffff;

  // The V buffer, local for the search and stored back for the next case.
  let v = V;
  let cap = Vcap;
  const ensure = (d) => {
    const need = (d + 1) * (d + 1);
    if (v !== null && wide === Vwide && need <= cap) return;
    const ncap = Math.max(need, cap * 2, 1 << 20);
    const nv = wide ? new Int32Array(ncap) : new Uint16Array(ncap);
    if (v !== null && wide === Vwide) nv.set(v.subarray(0, Math.min(cap, ncap)));
    v = nv;
    cap = ncap;
    Vwide = wide;
  };

  let D = -1;
  let kEnd = 0;
  // d = 0: the snake from (0, 0).
  let x = 0;
  let y = 0;
  while (x < n && y < m && A[x] === B[y]) { x++; y++; }
  ensure(0);
  v[0] = x;
  if (x < n || y < m) {
    outer: for (let d = 1; ; d++) {
      ensure(d);
      const base = d * d;
      const prev = (d - 1) * (d - 1);
      const pd = d - 1;
      // Edge k = -d: only the insertion candidate (from k+1 = -(d-1)).
      {
        const xa = v[prev];
        if (xa !== UNDEF && xa + d - 1 < m) {
          let xx = xa;
          let yy = xx + d;
          while (xx < n && yy < m && A[xx] === B[yy]) { xx++; yy++; }
          v[base] = xx;
          if (xx >= n && yy >= m) { D = d; kEnd = -d; break outer; }
        } else {
          v[base] = UNDEF;
        }
      }
      // Interior k = -d+2 .. d-2: both candidates exist; running indices.
      // For k = -d+2: xr is V_{d-1}[k-1] at prev+0, xa is V_{d-1}[k+1] at prev+2.
      let r = prev; // V index of xr (k-1) for k = -d+2
      let a = prev + 2; // V index of xa (k+1) for k = -d+2
      let w = base + 2; // V index to write for k = -d+2
      for (let k = -d + 2; k <= d - 2; k += 2, r += 2, a += 2, w += 2) {
        const xr = v[r];
        const xa = v[a];
        const canR = xr !== UNDEF && xr < n;
        const canA = xa !== UNDEF && xa - k - 1 < m;
        if (!canR && !canA) {
          v[w] = UNDEF;
          continue;
        }
        let xx;
        if (canR && (!canA || xr + 1 >= xa)) xx = xr + 1; // deletion wins ties
        else xx = xa; // insertion
        let yy = xx - k;
        while (xx < n && yy < m && A[xx] === B[yy]) { xx++; yy++; }
        v[w] = xx;
        if (xx >= n && yy >= m) {
          D = d;
          kEnd = k;
          break outer;
        }
      }
      // Edge k = d: only the deletion candidate (from k-1 = d-1).
      {
        const xr = v[prev + 2 * pd];
        if (xr !== UNDEF && xr < n) {
          let xx = xr + 1;
          let yy = xx - d;
          while (xx < n && yy < m && A[xx] === B[yy]) { xx++; yy++; }
          v[base + 2 * d] = xx;
          if (xx >= n && yy >= m) { D = d; kEnd = d; break outer; }
        } else {
          v[base + 2 * d] = UNDEF;
        }
      }
    }
  } else {
    D = 0;
  }

  // Backtrack from (D, kEnd): the same choice rule at every step, so the
  // script is the reference's. Runs are collected in reverse, then flipped.
  const rev = [];
  let k = kEnd;
  for (let d = D; d >= 1; d--) {
    const base = d * d;
    const prev = (d - 1) * (d - 1);
    const pd = d - 1;
    const xx = v[base + k + d];
    const xr = k - 1 >= -pd ? v[prev + (k - 1) + pd] : UNDEF;
    const xa = k + 1 <= pd ? v[prev + (k + 1) + pd] : UNDEF;
    const canR = xr !== UNDEF && xr < n;
    const canA = xa !== UNDEF && xa - k - 1 < m;
    let isDel;
    let px;
    let pk;
    if (canR && (!canA || xr + 1 >= xa)) {
      isDel = true;
      px = xr + 1;
      pk = k - 1;
    } else {
      isDel = false;
      px = xa;
      pk = k + 1;
    }
    const snake = xx - px;
    if (snake > 0) rev.push([KEEP, snake]);
    rev.push([isDel ? DELETE : INSERT, 1]);
    k = pk;
  }
  const x0 = v[0];
  if (x0 > 0) rev.push([KEEP, x0]);

  // Store the buffer back for the next case.
  V = v;
  Vcap = cap;
  Vwide = wide;

  // Flip and coalesce runs of one kind.
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const [kind, count] = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += count;
    else runs.push([kind, count]);
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const aStr = splitLines(input.old);
  const bStr = splitLines(input.new);
  const n = aStr.length;
  const m = bStr.length;

  // Intern both texts' lines to ids in one map, so equal lines share an id.
  const ids = new Map();
  const a = new Int32Array(n);
  const b = new Int32Array(m);
  for (let i = 0; i < n; i++) {
    const s = aStr[i];
    let id = ids.get(s);
    if (id === undefined) { id = ids.size; ids.set(s, id); }
    a[i] = id;
  }
  for (let j = 0; j < m; j++) {
    const s = bStr[j];
    let id = ids.get(s);
    if (id === undefined) { id = ids.size; ids.set(s, id); }
    b[j] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  runs.push(...editRuns(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix)));
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const CONTEXT = 3;
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aStr[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aStr[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bStr[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aStr[at]));
  }
  return out.join('');
}

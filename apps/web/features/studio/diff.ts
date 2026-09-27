/** One run of paragraphs in a comparison: kept by both texts, or only in one of them. */
export interface DiffRun { kind: 'both' | 'mine' | 'theirs'; lines: string[] }

// A 64 KiB draft has at most a few thousand paragraphs; past this many cells the
// middle is shown as one replaced block instead of an exact alignment.
const MAX_CELLS = 4_000_000;

/**
 * Paragraph-level comparison of two drafts (one paragraph per line, as Content
 * text drafts store them): common prefix and suffix, then a longest-common-
 * subsequence alignment of the middle.
 */
export function diffParagraphs(mine: string, theirs: string): DiffRun[] {
  const a = mine.split('\n');
  const b = theirs.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const runs: DiffRun[] = [];
  const push = (kind: DiffRun['kind'], line: string) => {
    const last = runs.at(-1);
    if (last?.kind === kind) last.lines.push(line);
    else runs.push({ kind, lines: [line] });
  };
  for (const line of a.slice(0, start)) push('both', line);
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
    for (const line of x) push('mine', line);
    for (const line of y) push('theirs', line);
  } else {
    // lengths[i][j]: LCS length of x[i..] and y[j..], row-major.
    const width = y.length + 1;
    const lengths = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) {
        lengths[i * width + j] = x[i] === y[j] ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { push('both', x[i]!); i += 1; j += 1; }
      else if (j >= y.length || (i < x.length && lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
        push('mine', x[i]!); i += 1;
      } else { push('theirs', y[j]!); j += 1; }
    }
  }
  for (const line of a.slice(a.length - end)) push('both', line);
  return runs;
}

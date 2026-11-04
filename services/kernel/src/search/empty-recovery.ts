export type EmptyRecoveryAction =
  | { kind: 'edit-query' }
  | { kind: 'remove-type' }
  | { kind: 'remove-kind'; value: string }
  | { kind: 'remove-facet'; property: string; value: string }
  | { kind: 'remove-range'; property: string };

export type EmptyRecoveryEnvelope = {
  status: 'ready' | 'preparing' | 'unavailable';
  alternatives: { query: string; label: string }[];
  actions: EmptyRecoveryAction[];
};

export type EmptyRecoveryCandidate = { id: string; label: string };

export const EMPTY_RECOVERY_LIMITS = {
  reads: 2,
  candidatesPerRead: 8,
  alternatives: 3,
  actions: 8,
  labelCodePoints: 128,
  envelopeBytes: 16_384,
} as const;

const wideText = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const fold = (value: string) => value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const points = (value: string) => [...value];

/** At most two short prefixes, matching the existing spelling-tolerant Search recovery behaviour. */
export function emptyRecoveryPrefixes(query: string): string[] {
  const normalized = fold(query);
  if (!normalized) return [];
  if (wideText.test(normalized)) return [points(normalized)[0]!];
  const longest = normalized.split(' ').reduce((best, word) => (points(word).length > points(best).length ? word : best), '');
  const letters = points(longest);
  if (letters.length < 3) return [];
  return [...new Set([letters.slice(0, 3).join(''), letters.slice(0, 2).join('')])];
}

function editDistance(left: string, right: string): number {
  const a = points(left);
  const b = points(right);
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

function closeness(query: string, label: string): number {
  const typed = fold(query);
  const title = fold(label);
  const letters = points(typed);
  const titlePoints = points(title);
  if (!letters.length || !titlePoints.length) return Number.POSITIVE_INFINITY;
  const starts = wideText.test(typed)
    ? titlePoints.map((_, index) => index)
    : titlePoints.flatMap((character, index) =>
        (index === 0 || titlePoints[index - 1] === ' ') && character !== ' ' ? [index] : [],
      );
  let best = Number.POSITIVE_INFINITY;
  for (const start of starts)
    for (const span of [letters.length - 1, letters.length, letters.length + 1])
      if (span > 0 && start + span <= titlePoints.length + 1)
        best = Math.min(best, editDistance(typed, titlePoints.slice(start, start + span).join('').trim()));
  return best;
}

function tolerance(query: string): number {
  const normalized = fold(query);
  const length = points(normalized.replace(/ /g, '')).length;
  if (wideText.test(normalized)) return length >= 2 ? 1 : 0;
  return length < 3 ? 0 : Math.max(1, Math.floor(length / 4));
}

function normalizeActions(actions: readonly EmptyRecoveryAction[]): EmptyRecoveryAction[] {
  const seen = new Set<string>();
  const result: EmptyRecoveryAction[] = [];
  for (const action of actions.slice(0, EMPTY_RECOVERY_LIMITS.actions)) {
    if (
      ('property' in action && points(action.property).length > EMPTY_RECOVERY_LIMITS.labelCodePoints) ||
      ('value' in action && points(action.value).length > EMPTY_RECOVERY_LIMITS.labelCodePoints)
    )
      continue;
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function responseBytes(value: EmptyRecoveryEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedEnvelope(
  status: EmptyRecoveryEnvelope['status'],
  candidates: readonly EmptyRecoveryCandidate[],
  actions: readonly EmptyRecoveryAction[],
): EmptyRecoveryEnvelope {
  const safeActions = normalizeActions(actions);
  const alternatives = candidates.slice(0, EMPTY_RECOVERY_LIMITS.alternatives).flatMap(({ label }) => {
    const query = label.trim();
    if (!query || points(query).length > EMPTY_RECOVERY_LIMITS.labelCodePoints) return [];
    if (new TextEncoder().encode(query).byteLength > EMPTY_RECOVERY_LIMITS.labelCodePoints * 4) return [];
    return [{ query, label: query }];
  });
  const value: EmptyRecoveryEnvelope = { status, alternatives, actions: safeActions };
  while (value.alternatives.length && responseBytes(value) > EMPTY_RECOVERY_LIMITS.envelopeBytes)
    value.alternatives.pop();
  return responseBytes(value) <= EMPTY_RECOVERY_LIMITS.envelopeBytes
    ? value
    : { status: 'unavailable', alternatives: [], actions: [] };
}

/** Fail closed if either bounded read, the shared freshness cut or the aggregate byte bound is uncertain. */
export async function readEmptyRecovery(input: {
  query: string;
  asOf: string;
  actions: readonly EmptyRecoveryAction[];
  read(prefix: string, limit: number): Promise<{ asOf: string; candidates: readonly EmptyRecoveryCandidate[] }>;
  failureStatus?: (error: unknown) => 'preparing' | 'unavailable';
}): Promise<EmptyRecoveryEnvelope> {
  const prefixes = emptyRecoveryPrefixes(input.query).slice(0, EMPTY_RECOVERY_LIMITS.reads);
  if (!prefixes.length) return boundedEnvelope('unavailable', [], input.actions);
  try {
    const reads = await Promise.allSettled(
      prefixes.map((prefix) => input.read(prefix, EMPTY_RECOVERY_LIMITS.candidatesPerRead)),
    );
    const failed = reads.find((read): read is PromiseRejectedResult => read.status === 'rejected');
    if (failed) throw failed.reason;
    const pages = reads.map((read) => {
      if (read.status !== 'fulfilled') throw new Error('Empty recovery read did not settle');
      return read.value;
    });
    if (pages.some((page) => page.asOf !== input.asOf)) return boundedEnvelope('unavailable', [], input.actions);
    const threshold = tolerance(input.query);
    const candidates = new Map<string, { candidate: EmptyRecoveryCandidate; distance: number; order: number }>();
    let order = 0;
    for (const page of pages)
      for (const candidate of page.candidates.slice(0, EMPTY_RECOVERY_LIMITS.candidatesPerRead)) {
        const distance = closeness(input.query, candidate.label);
        if (
          !candidate.id ||
          !candidate.label.trim() ||
          fold(candidate.label) === fold(input.query) ||
          distance > threshold ||
          new TextEncoder().encode(candidate.label).byteLength > EMPTY_RECOVERY_LIMITS.labelCodePoints * 4
        ) {
          order++;
          continue;
        }
        const prior = candidates.get(candidate.id);
        if (!prior || distance < prior.distance) candidates.set(candidate.id, { candidate, distance, order });
        order++;
      }
    const near = [...candidates.values()]
      .sort((left, right) => left.distance - right.distance || left.order - right.order)
      .slice(0, EMPTY_RECOVERY_LIMITS.alternatives)
      .map(({ candidate }) => candidate);
    return boundedEnvelope('ready', near, input.actions);
  } catch (error) {
    return boundedEnvelope(input.failureStatus?.(error) ?? 'unavailable', [], input.actions);
  }
}

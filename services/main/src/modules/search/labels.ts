import { lit } from '../work/activate.ts';
import {
  WorkReadInvalid,
  WorkReadMoved,
  WorkReadUnavailable,
  type ReadRow,
  type WorkReadSession,
} from '../work/read-session.ts';
import { assertPublicTextReady, assertSameTextInstance } from '../work/search-readiness.ts';
import { knownSearchPosition } from './snapshot-state.ts';
import { searchGraphSnapshot } from './snapshot-state.ts';
import { fenceSearchGraphSnapshot } from './snapshot.ts';

/** Use the search owner's uncertainty, restore, graph/index and process gates. */
export async function labelIndexReady(session: WorkReadSession, repin = false) {
  const position = await assertPublicTextReady(
    session.deps.environment.fuseki,
    session.deps.environment.lineage,
  );
  if (
    position.dataEpoch !== session.position.dataEpoch ||
    position.sequence !== session.position.sequence
  ) {
    if (repin) session.repin(position);
    else throw new WorkReadMoved('Label index changed');
  }
  return position;
}

/** Native commit/doc numbers are seek metadata. The ordered identities and
 * continuation presence prove this page's result when unrelated titles move. */
function labelPageFenceRows(rows: readonly ReadRow[]): ReadRow[] {
  return rows.map(row => {
    try {
      const page = JSON.parse(row.page?.value ?? '') as { hits: { id: string; key: string | null }[];
        more: boolean; restart?: boolean };
      return { page: { type: 'literal', value: JSON.stringify({
        hits: page.hits.map(hit => [hit.id, hit.key]), more: page.more, restart: !!page.restart,
      }) } };
    } catch { return row; }
  });
}
export const fenceLabelIndex = async (
  session: WorkReadSession,
  position: Awaited<ReturnType<typeof labelIndexReady>>,
) => {
  if (searchGraphSnapshot.getStore()?.graphBasis === 'selected-units') {
    session.observeDependency('label-index', true, async () => {
      await fenceSearchGraphSnapshot(session.deps.environment, position, 'selected-units');
      return true;
    });
  } else await assertSameTextInstance(session.deps.environment.fuseki, position);
};

export interface LabelAfter {
  id: string;
  score: string;
  commit: string;
  document: number;
}
export type DirectoryAfter = Omit<LabelAfter, 'document'>;

/** Seek an ordered native projection by kind. This walks <=64 dictionary keys,
 * never scans/sorts public titles; deleted keys retain an advancing cursor. */
export async function publicNamePage(
  session: WorkReadSession,
  kind: string,
  order: 'identity' | 'newest' | 'updated',
  limit: number,
  after?: DirectoryAfter,
) {
  const shared = knownSearchPosition(
    session.deps.environment.fuseki,
    session.deps.environment.lineage,
  );
  const position = shared ?? await labelIndexReady(session);
  const rows = await session.query(
    `SELECT ?page WHERE {
    BIND(rv:rankedText(rv:publicTitle, "", ${limit}, ${lit(after ? JSON.stringify(after) : '')},
      ${lit(JSON.stringify({ names: kind, directory: order }))}) AS ?page)
  } LIMIT 1`,
    1,
    labelPageFenceRows,
  );
  let page: {
    hits: { id: string; key: string | null; score: string }[];
    more: boolean;
    commit: string;
    restart?: boolean;
  };
  try {
    page = JSON.parse(rows[0]?.page?.value ?? '');
  } catch {
    throw new WorkReadUnavailable('Name directory is unavailable');
  }
  if (page.restart) throw new WorkReadMoved('Name directory changed');
  const prefix =
    order === 'identity'
      ? `urn:rezics:search:name:${kind}:`
      : `urn:rezics:search:directory:${kind}:${order}:`;
  if (
    !Array.isArray(page.hits) ||
    page.hits.length > limit ||
    typeof page.more !== 'boolean' ||
    !/^\d+$/.test(page.commit) ||
    page.hits.some(
      (hit) =>
        typeof hit.id !== 'string' ||
        !hit.id.startsWith(prefix) ||
        (hit.key !== null && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(hit.key)),
    )
  )
    throw new WorkReadUnavailable('Name directory returned an invalid page');
  if (!shared) await fenceLabelIndex(session, position);
  return {
    more: page.more,
    rows: page.hits.map((hit) => ({
      id: hit.key ?? 'https://rezics.com/id/' + hit.id.split(':').at(-1),
      available: hit.key !== null,
      order:
        order === 'identity' ? '0' : String(10n ** 40n - 1n - BigInt(hit.id.split(':').at(-2)!)),
      after: { id: hit.id, score: '0', commit: page.commit } satisfies DirectoryAfter,
    })),
  };
}
export type NameMatchMode = 'keywords' | 'phrase';
/** Bound the submitted Unicode text before normalizing it. An empty result is
 * browse input; callers requiring text reject it before opening the index. */
export function normalizeNameQuery(q: string): string {
  if ([...q].length > 80 || /[\u0000-\u001f\u007f]/u.test(q)) {
    throw new WorkReadInvalid('Search text is invalid');
  }
  const normalized = q.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if ([...normalized].length > 80) throw new WorkReadInvalid('Search text is invalid');
  return normalized;
}

interface LabelHit {
  id: string;
  key: string | null;
  score: string;
  document: number;
}
/** Search only the current public name projection through the existing native
 * ranked guard. Each alias document advances; only its best hit names a unit. */
export async function indexedLabels(
  session: WorkReadSession,
  q: string,
  limit: number,
  after?: LabelAfter,
  kind = 'all',
  resources?: readonly string[],
  matchMode: NameMatchMode = 'keywords',
) {
  const phrase = normalizeNameQuery(q);
  if (!phrase) throw new WorkReadInvalid('Search text is invalid');
  const shared = knownSearchPosition(
    session.deps.environment.fuseki,
    session.deps.environment.lineage,
  );
  const position = shared ?? await labelIndexReady(session);
  const rows = await session.query(
    `SELECT ?page WHERE {
    BIND(rv:rankedText(rv:publicTitle, ${lit(phrase)}, ${limit}, ${lit(after ? JSON.stringify(after) : '')}, ${lit(JSON.stringify({ names: kind, matchMode, ...(resources ? { resources } : {}) }))}) AS ?page)
  } LIMIT 1`,
    1,
    labelPageFenceRows,
  );
  let page: { hits: LabelHit[]; more: boolean; commit: string; restart?: boolean };
  try {
    page = JSON.parse(rows[0]?.page?.value ?? '');
  } catch {
    throw new WorkReadUnavailable('Label index is unavailable');
  }
  if (page.restart) throw new WorkReadMoved('Label index changed; restart from the first page');
  if (
    !Array.isArray(page.hits) ||
    page.hits.length > limit ||
    typeof page.more !== 'boolean' ||
    !/^\d+$/.test(page.commit) ||
    (page.more && !page.hits.length) ||
    page.hits.some(
      (hit) =>
        typeof hit.id !== 'string' ||
        (hit.key !== null && hit.key !== hit.id) ||
        typeof hit.score !== 'string' ||
        !Number.isFinite(Number(hit.score)) ||
        !Number.isSafeInteger(hit.document) ||
        hit.document < 0,
    )
  ) {
    throw new WorkReadUnavailable('Label index returned an invalid page');
  }
  const last = page.hits.at(-1);
  if (!shared) await fenceLabelIndex(session, position);
  return {
    ids: page.hits.flatMap((hit) =>
      hit.key === null ? [] : ['https://rezics.com/id/' + hit.id.split(':').at(-1)],
    ),
    hits: page.hits,
    commit: page.commit,
    more: page.more,
    after: last
      ? { id: last.id, score: last.score, document: last.document, commit: page.commit }
      : undefined,
  };
}

/** A bound-subject indexed test has no population cap. Fields remain separate
 * authored names, so words cannot match by concatenating unrelated labels. */
export function indexedNameMatch(resource: string, q: string, matchMode: NameMatchMode = 'phrase') {
  const phrase = normalizeNameQuery(q);
  if (!phrase) throw new WorkReadInvalid('Search text is invalid');
  // The subject restriction enters the existing native collector before text
  // retrieval. A global text:query limit could otherwise select another unit.
  const scope = `CONCAT(${lit(JSON.stringify({ names: 'all', matchMode }).slice(0, -1) + ',"resources":["')}, STR(${resource}), ${lit('"]}')})`;
  return `FILTER(REGEX(STR(rv:rankedText(rv:publicTitle, ${lit(phrase)}, 1, "", ${scope})),
    ${lit('"key"\\s*:\\s*"urn:rezics:search:name:')}))`;
}

import { MAX_PAGE_COST, MAX_PAGE_READS } from '@rezics/composition';
import { relationFacetProperty } from '@rezics/filter';
import type { Pool } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IndexedSubject, SubjectSnapshot } from '../search/index.ts';
import { activeRelease, readBaseReleases, readRelease } from './definition-release-read.ts';
import { withoutFencedEntries } from './fences.ts';
import { withReadTransaction } from './read.ts';
import { normalizeSourceStatement } from './scope-leaf-selection.ts';
import readNames from './search-source-book-names.sql';

const LABEL_LIMIT = 65;
const LANGUAGE_LIMIT = 33;
const LANGUAGE_PROPERTY = 'schema:inLanguage';

type SelectedLanguage = {
  route: number;
  subject_id: string;
  slot_id: string;
  candidate_id: string;
  release: string;
  value: unknown;
};
type NameRow = {
  id: string;
  route: number;
  position: string | null;
  writeState: string | null;
  movedTo: string | null;
  type: string | null;
  visibility: IndexedSubject['visibility'] | null;
  securityRevision: string | null;
  redirect: string | null;
  ready: boolean;
  labels: IndexedSubject['labels'] | null;
  languages: SelectedLanguage[] | null;
  wide: boolean;
};

/** The catalogue needs current labels and the language fallback used by projectHit. */
export function bookCandidateNames(
  pool: Pool,
  routeKey: Uint8Array | undefined,
  resume: (deadline: number, subject: { route: number; id: string }) => Promise<void>,
) {
  // Two candidates per output slot and one lookahead per list.
  const windowKeys = 2 * MAX_PAGE_COST + MAX_PAGE_READS;
  return async (ids: readonly string[]): Promise<ReadonlyMap<number, SubjectSnapshot> | null> => {
    if (ids.length > windowKeys) return null;
    const routes = ids.map((id) => {
      const route = routeOf(id);
      if (route === null) throw new TypeError('Book candidate id must be a routable subject key');
      return route;
    });
    if (new Set(ids).size !== ids.length) throw new TypeError('Duplicate Book candidate key');
    if (!ids.length) return new Map();

    const deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
    const result = await withReadTransaction(
      pool,
      async (client) => {
        // Even in a small home, seek each requested key instead of rescanning the home for every candidate.
        await client.query('SET LOCAL enable_seqscan = off');
        const rows = (await nativeSourceQuery(client, readNames, {
          routes,
          subject_ids: [...ids],
          label_limit: LABEL_LIMIT,
          language_limit: LANGUAGE_LIMIT,
        })) as NameRow[];
        const snapshots = new Map<number, SubjectSnapshot>();
        const subjects = new Map<string, IndexedSubject>();
        const wanted = new Set(ids);
        for (const row of rows) {
          if (!wanted.delete(row.id) || routeOf(row.id) !== row.route) throw new Error('Unexpected Book candidate key');
          const partition = partitionOf(row.route);
          if (row.position === null || row.writeState === null) throw new CommandUnavailableError('fenced', partition);
          if (row.writeState === 'moved') throw new CommandUnavailableError('moved', partition, row.movedTo);
          let snapshot = snapshots.get(partition);
          if (!snapshot) {
            snapshot = { partition, position: BigInt(row.position), subjects: [] };
            snapshots.set(partition, snapshot);
          }
          if (row.type === null) continue;
          if (!row.ready) return { pending: row } as const;
          if (row.visibility === null || row.securityRevision === null) throw new Error('Incomplete Book candidate');
          const subject: IndexedSubject = {
            id: row.id,
            type: row.type,
            visibility: row.redirect ? 'hidden' : row.visibility,
            securityRevision: Number(row.securityRevision),
            redirect: row.redirect,
            labels: row.labels ?? [],
            descriptions: [],
            aliases: [],
            statements: [],
          };
          subjects.set(row.id, subject);
          snapshot.subjects.push(subject);
        }
        if (wanted.size) throw new Error('Incomplete Book candidate keys');
        if (rows.some((row) => row.wide)) return null;

        // An active release with a relational language property needs the full relation Source.
        const runtime = subjects.size ? await activeRelease(client, 'native') : null;
        if (routeKey && runtime && relationFacetProperty(runtime.release, LANGUAGE_PROPERTY)) return null;
        const selected = rows.flatMap((row) => row.languages ?? []);
        const visible: SelectedLanguage[] = [];
        for (let offset = 0; offset < selected.length; offset += 256) {
          const batch = selected.slice(offset, offset + 256);
          visible.push(...(routeKey ? await withoutFencedEntries(client, routeKey, batch) : batch));
        }
        const digests = [...new Set(visible.map(({ release }) => release))];
        const releases = await readBaseReleases(client, digests);
        for (const digest of digests)
          if (!releases.has(digest)) releases.set(digest, await readRelease(client, digest));
        for (const row of visible) {
          const release = releases.get(row.release);
          if (!release) throw new Error(`Statement definition release ${row.release} is missing`);
          const statement = normalizeSourceStatement(LANGUAGE_PROPERTY, { value: row.value }, release.properties);
          const subject = subjects.get(row.subject_id)!;
          if (statement && subject.statements.length === 0) subject.statements.push(statement);
        }
        return { snapshots } as const;
      },
      deadline,
    );
    if (result?.pending) {
      await resume(deadline, result.pending);
      throw new CommandUnavailableError('contention', partitionOf(result.pending.route));
    }
    return result?.snapshots ?? null;
  };
}

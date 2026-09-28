import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { Static } from 'typebox';
import type { creditItem } from '../work/read-contract.ts';
import type { AuthorName } from './author-name.ts';

const reads = new WeakMap<WorkReadSession, Map<string, AuthorName | null>>();
const reportedReads = new WeakMap<WorkReadSession, Map<string, string>>();
export const SOURCE_REPORTED_CREDIT_COST = { works: 64, names: 192, perWork: 128,
  sourceQueriesPerRead: 1, sourceFenceQueries: 1, nameQueriesPerRead: 1 } as const;

/** Current source facts are read once per page, not copied into discovery's
 * projection. A final fence covers refresh/removal during any Work read. */
export async function readAuthorNames(session: WorkReadSession, keys: readonly string[]) {
  const selected = [...new Set(keys)];
  const names = await session.deps.sourceAuthorNames?.batch(selected) ?? new Map<string, AuthorName>();
  const prior = reads.get(session) ?? new Map<string, AuthorName | null>();
  for (const key of selected) {
    const value = names.get(key) ?? null;
    if (prior.has(key) && JSON.stringify(prior.get(key)) !== JSON.stringify(value)) {
      throw new WorkReadMoved('Source author names changed during the read');
    }
    prior.set(key, value);
  }
  reads.set(session, prior);
  session.checkDeadline();
  return names;
}

export async function fenceAuthorNames(session: WorkReadSession) {
  const prior = reads.get(session);
  if (prior?.size) await readAuthorNames(session, [...prior.keys()]);
  const reported = reportedReads.get(session);
  if (reported?.size) {
    const current = await session.deps.sourceAdoptions?.authorReferences([...reported.keys()]) ?? new Map();
    for (const [work, value] of reported) {
      if (JSON.stringify(current.get(work) ?? []) !== value) {
        throw new WorkReadMoved('Source author binding changed during the read');
      }
    }
  }
}

/** A bounded, read-only attribution from the retained adoption. A confirmed
 * graph credit for the same source occurrence replaces it at the caller. */
export async function sourceReportedCredits(session: WorkReadSession, works: readonly string[],
  perWork = 3): Promise<Map<string, Static<typeof creditItem>[]>> {
  if (works.length > SOURCE_REPORTED_CREDIT_COST.works || perWork < 1
    || perWork > SOURCE_REPORTED_CREDIT_COST.perWork
    || works.length * perWork > SOURCE_REPORTED_CREDIT_COST.names) {
    throw new WorkReadUnavailable('Source author batch exceeds its bound');
  }
  if (!works.length || !session.deps.sourceAdoptions) return new Map();
  const refs = await session.deps.sourceAdoptions?.authorReferences(works)
    ?? new Map<string, Array<{ id: string; key: string; ordinal: number }>>();
  const prior = reportedReads.get(session) ?? new Map<string, string>();
  for (const work of works) {
    const value = JSON.stringify(refs.get(work) ?? []);
    if (prior.has(work) && prior.get(work) !== value) {
      throw new WorkReadMoved('Source author binding changed during the read');
    }
    prior.set(work, value);
  }
  reportedReads.set(session, prior);
  const selected = [...refs.values()].flatMap(items => items.slice(0, perWork));
  const names = await readAuthorNames(session, selected.map(item => item.key));
  return new Map([...refs].map(([work, items]) => [work, items.slice(0, perWork).map(item => ({
    id: item.id, role: 'author' as const, participantKind: 'external-reference' as const,
    provider: 'open-library' as const, key: item.key, ordinal: item.ordinal,
    agent: null, displayName: names.get(item.key)?.displayName ?? null, handle: null,
    confirmation: 'source-reported' as const,
    ...(names.get(item.key)?.nameSource ? { nameSource: names.get(item.key)!.nameSource } : {}),
  }))]));
}

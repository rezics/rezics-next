import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { Static } from 'typebox';
import type { creditItem } from '../work/read-contract.ts';
import type { AuthorName } from './author-name.ts';
import { SOURCE_ADOPTION_READ_COST } from './native-work-adoption.ts';

const reads = new WeakMap<WorkReadSession, Map<string, AuthorName | null>>();
const reportedReads = new WeakMap<WorkReadSession, Map<string, string>>();
/** A followed-author page records at most 8×64 Works and a discovery build at most
 * 250, so the binding fence adds at most eight PostgreSQL reads and no Fuseki calls. */
export const SOURCE_REPORTED_CREDIT_COST = { works: 64, names: 192, perWork: 128,
  sourceQueriesPerRead: 1, sourceFenceQueries: 8, nameQueriesPerRead: 1 } as const;

/** Raw server-owned attribution tuples, before candidate selection or names. */
export async function sourceCreditReferences(session: WorkReadSession, works: readonly string[]) {
  const read = async () => {
    const refs = await session.deps.sourceAdoptions?.authorReferences(works) ?? new Map<string,Array<{id:string;key:string;ordinal:number}>>();
    return works.map(work=>[work,refs.get(work) ?? []] as const);
  };
  const rows = await read();
  if (works.length>64 || rows.reduce((sum,[,refs])=>sum+refs.length,0)>128) throw new WorkReadUnavailable('Source credit bindings exceed their bound');
  session.observeDependency(`source-credit-tuples:${JSON.stringify(works)}`,rows,read);
  recordReported(session,works,new Map(rows));
  return rows.flatMap(([work,refs])=>refs.map(ref=>({work,...ref})));
}

/** Current source facts are read once per page, not copied into discovery's
 * projection. A final fence covers refresh/removal during any Work read. */
export async function readAuthorNames(session: WorkReadSession, keys: readonly string[], preview = false) {
  const selected = [...new Set(keys)];
  if (preview && !selected.length) return new Map<string, AuthorName>();
  const names = await session.deps.sourceAuthorNames?.batch(selected) ?? new Map<string, AuthorName>();
  if (preview) {
    // Optional cards fence their own names, without making owner recovery a
    // mandatory page-delivery fence. Withhold only the changed source name.
    const current = await session.deps.sourceAuthorNames?.batch(selected) ?? new Map<string, AuthorName>();
    session.checkDeadline();
    return new Map([...names].filter(([key, value]) => JSON.stringify(value) === JSON.stringify(current.get(key))));
  }
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

type ReportedAuthorRef = { id: string; key: string; ordinal: number };

/** The fence compares each recorded binding, so it rereads every Work the read
 * retained. `authorReferences` accepts at most `authorWorks` Works; chunks stay
 * inside that cap and merge by Work. Callers record a page, not the corpus:
 * a discovery build keeps 250 Works (four lookups) and a followed-author page
 * keeps 8×64 (eight). Those lookups are PostgreSQL, not Fuseki. */
async function fencedAuthorReferences(session: WorkReadSession, works: readonly string[]) {
  const merged = new Map<string, ReportedAuthorRef[]>();
  const adoptions = session.deps.sourceAdoptions;
  if (!adoptions || !works.length) return merged;
  const size = SOURCE_ADOPTION_READ_COST.authorWorks;
  for (let offset = 0; offset < works.length; offset += size) {
    const part = await adoptions.authorReferences(works.slice(offset, offset + size));
    for (const [work, refs] of part) merged.set(work, refs);
    session.checkDeadline();
  }
  return merged;
}

export async function fenceAuthorNames(session: WorkReadSession) {
  const prior = reads.get(session);
  if (prior?.size) await readAuthorNames(session, [...prior.keys()]);
  const reported = reportedReads.get(session);
  if (reported?.size) {
    const current = await fencedAuthorReferences(session, [...reported.keys()]);
    for (const [work, value] of reported) {
      if (JSON.stringify(current.get(work) ?? []) !== value) {
        throw new WorkReadMoved('Source author binding changed during the read');
      }
    }
  }
}

/** Records the retained author references of these Works for the read's final fence. */
function recordReported(session: WorkReadSession, works: readonly string[],
  refs: Map<string, Array<{ id: string; key: string; ordinal: number }>>) {
  const prior = reportedReads.get(session) ?? new Map<string, string>();
  for (const work of works) {
    const value = JSON.stringify(refs.get(work) ?? []);
    if (prior.has(work) && prior.get(work) !== value) {
      throw new WorkReadMoved('Source author binding changed during the read');
    }
    prior.set(work, value);
  }
  reportedReads.set(session, prior);
}

/**
 * Works a retained adoption reports for one author, found through the reverse
 * index and read forward again, so a Work is listed only while its binding
 * still names the author and a change before the read ends moves it. At most
 * `AUTHOR_WORKS_COST.works` Works; `complete` says whether that was all.
 */
export async function sourceReportedAuthorWorks(session: WorkReadSession, key: string) {
  const store = session.deps.sourceAuthorNames, adoptions = session.deps.sourceAdoptions;
  if (!store || !adoptions) return { works: [] as string[], complete: true };
  const found = await store.reportedWorks(key);
  const refs = await adoptions.authorReferences(found.works);
  recordReported(session, found.works, refs);
  session.checkDeadline();
  return { works: found.works.filter(work => refs.get(work)?.some(ref => ref.key === key)), complete: found.complete };
}

/** A bounded, read-only attribution from the retained adoption. A confirmed
 * graph credit for the same source occurrence replaces it at the caller. */
export async function sourceReportedCredits(session: WorkReadSession, works: readonly string[],
  perWork = 3, preview = false): Promise<Map<string, Static<typeof creditItem>[]>> {
  if (works.length > SOURCE_REPORTED_CREDIT_COST.works || perWork < 1
    || perWork > SOURCE_REPORTED_CREDIT_COST.perWork
    || works.length * perWork > SOURCE_REPORTED_CREDIT_COST.names) {
    throw new WorkReadUnavailable('Source author batch exceeds its bound');
  }
  if (!works.length || !session.deps.sourceAdoptions) return new Map();
  const refs = await session.deps.sourceAdoptions?.authorReferences(works)
    ?? new Map<string, Array<{ id: string; key: string; ordinal: number }>>();
  if (!preview) recordReported(session, works, refs);
  const selected = [...refs.values()].flatMap(items => items.slice(0, perWork));
  const names = await readAuthorNames(session, selected.map(item => item.key), preview);
  if (preview) {
    const current = await session.deps.sourceAdoptions.authorReferences(works);
    for (const [work, value] of refs) {
      if (JSON.stringify(value) !== JSON.stringify(current.get(work))) refs.delete(work);
    }
  }
  return new Map([...refs].map(([work, items]) => [work, items.slice(0, perWork).map(item => ({
    id: item.id, role: 'author' as const, participantKind: 'external-reference' as const,
    provider: 'open-library' as const, key: item.key, ordinal: item.ordinal,
    agent: null, displayName: names.get(item.key)?.displayName ?? null, handle: null,
    confirmation: 'source-reported' as const,
    ...(names.get(item.key)?.nameSource ? { nameSource: names.get(item.key)!.nameSource } : {}),
  }))]));
}

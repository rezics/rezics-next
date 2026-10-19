import { browserMainApi } from '../api/browser.ts';
import { type MaintainerName, maintainerTarget } from './rules.ts';

export interface MaintainerRoster {
  work: string;
  generation: string;
  owner: string;
  maintainers: readonly string[];
}

export interface MaintainerChangeResult {
  status: number;
  code: string | null;
  title: string | null;
  roster: MaintainerRoster | null;
  replayed: boolean;
}

export interface ResolvedMaintainer {
  id: string;
  name: MaintainerName;
}

/** The reads and the one write the panel uses. Stories pass a stand-in. */
export interface MaintainerSource {
  read(workId: string): Promise<MaintainerRoster | null>;
  names(ids: readonly string[]): Promise<Readonly<Record<string, MaintainerName>>>;
  resolve(query: string): Promise<ResolvedMaintainer | null>;
  change(input: {
    work: string; actingSubject: string; target: string; action: 'add' | 'remove';
    expectedGeneration: string; key: string;
  }): Promise<MaintainerChangeResult>;
}

type HttpAnswer = { data: unknown; error: { status: number; value: unknown } | null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function rosterOf(data: unknown): MaintainerRoster | null {
  const row = record(data);
  if (!row || typeof row.work !== 'string' || typeof row.generation !== 'string' || typeof row.owner !== 'string') return null;
  if (!Array.isArray(row.maintainers) || row.maintainers.some(item => typeof item !== 'string')) return null;
  return { work: row.work, generation: row.generation, owner: row.owner, maintainers: row.maintainers };
}

function nameOf(data: unknown): MaintainerName | null {
  const row = record(data);
  const info = record(row?.displayNameInfo);
  const displayName = typeof row?.displayName === 'string' ? row.displayName
    : typeof info?.value === 'string' ? info.value : null;
  if (!row || !displayName) return null;
  return { displayName, handle: typeof row.handle === 'string' ? row.handle : null };
}

function problemOf(error: HttpAnswer['error']): { status: number; code: string | null; title: string | null } {
  const row = record(error?.value);
  return {
    status: error?.status ?? 503,
    code: typeof row?.code === 'string' ? row.code : null,
    title: typeof row?.title === 'string' ? row.title : null,
  };
}

async function call(run: () => Promise<HttpAnswer>): Promise<HttpAnswer> {
  try { return await run(); } catch { return { data: null, error: { status: 503, value: null } }; }
}

/** Browser reads and writes through the BFF, as the signed-in session acting for `actingSubject`. */
export function browserMaintainers(actingSubject: string, main?: ReturnType<typeof browserMainApi>): MaintainerSource {
  let current = main;
  const client = () => current ??= browserMainApi();
  const idOf = (agent: string) => agent.slice(-36);
  const query = { actingSubject };
  const agentName = async (id: string): Promise<MaintainerName | null> => {
    const load = () => call(() => client().v1.agents({ id: idOf(id) }).get({ query }));
    let answer = await load();
    // A profile read answers 409 when the graph moves under it; one more read is the same profile.
    if (answer.error?.status === 409) answer = await load();
    return answer.error ? null : nameOf(answer.data);
  };
  return {
    async read(workId) {
      const answer = await call(() => client().v1.works({ id: idOf(workId) }).maintainers.get());
      return answer.error ? null : rosterOf(answer.data);
    },
    async names(ids) {
      const pairs = await Promise.all(ids.map(async id => {
        const name = await agentName(id);
        return name ? [id, name] as const : null;
      }));
      return Object.fromEntries(pairs.filter(pair => pair !== null));
    },
    async resolve(input) {
      const target = maintainerTarget(input);
      if (target.kind === 'invalid') return null;
      if (target.kind === 'iri') {
        const name = await agentName(target.iri);
        return name ? { id: target.iri, name } : null;
      }
      const answer = await call(() => client().v1.handles({ handle: target.handle }).get({ query }));
      const row = record(answer.data);
      const name = answer.error ? null : nameOf(answer.data);
      return name && typeof row?.id === 'string' ? { id: row.id, name } : null;
    },
    async change(input) {
      const answer = await call(() => client().v1['work-maintainer-changes'].post({
        profile: 'work-maintainer-change-v1', work: input.work, actingSubject: input.actingSubject,
        target: input.target, action: input.action, expectedGeneration: input.expectedGeneration,
      }, { headers: { 'idempotency-key': input.key } }));
      if (answer.error || !answer.data) {
        const problem = problemOf(answer.error);
        return { ...problem, roster: null, replayed: false };
      }
      const roster = rosterOf(answer.data);
      const replayed = record(answer.data)?.replayed === true;
      return { status: replayed ? 200 : 201, code: null, title: null, roster, replayed };
    },
  };
}

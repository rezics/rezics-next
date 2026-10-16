import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { authorCredit, authorWorksPage, externalAuthorRead } from '../src/modules/author-page/contract.ts';
import { readExternalAuthor, readExternalAuthorWorks } from '../src/modules/author-page/read.ts';
import type { DeletedPersonAttributionProof } from '../src/modules/profiles/attribution.ts';
import { WorkReadSession, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const work = id(1), deleted = id(2), live = id(3), key = '/authors/OL1A';
const term = (value: string) => ({ type: 'literal', value });
const proof: DeletedPersonAttributionProof = { accountErasureId: id(8), erasureId: id(9), erasureEpoch: '12' };

function fixture(tombstone = true) {
  const query = async (body: string): Promise<ReadRow[]> => {
    if (body.includes('SELECT DISTINCT ?id ?main')) return [{ id: term(work), main: term(id(20)), head: term(id(21)) }];
    if (body.includes('SELECT ?work ?head')) return [{ work: term(work) }];
    if (body.includes('SELECT ?work ?id ?key ?ordinal ?agent')) return [
      { work: term(work), id: term(id(10)), agent: term(deleted) },
      { work: term(work), id: term(id(11)), agent: term(live) },
    ];
    if (body.includes('SELECT ?agent ?displayName')) return [
      { agent: term(live), displayName: term('Continuing author') },
    ];
    if (body.includes('SELECT ?context') || body.includes('SELECT ?work ?type')) return [];
    throw new Error(`Unexpected author-page query: ${body}`);
  };
  const deps = {
    environment: { fuseki: { query: async (body: string) => ({ results: { bindings: await query(body) } }) } },
    access: { assertRecoveryOpen: async () => undefined },
    personPreferences: { visibleNameOwners: async (agents: readonly string[]) =>
      new Set(agents.filter(agent => agent === live)) },
    agentHandles: { current: async () => 'continuing-author' },
    personAttributionTombstones: { read: async (agents: readonly string[]) =>
      new Map(tombstone && agents.includes(deleted) ? [[deleted, proof]] : []) },
  } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.invalid/v1/authors/open-library/OL1A'),
    {}, { dataEpoch: 'epoch:1', sequence: '42' });
  session.query = query;
  session.summaries = async () => [{ reference: work, status: 'available', type: 'work', disclosure: 'public',
    name: { value: 'Surviving Work', language: 'en', direction: 'ltr', basis: 'fallback' },
    avatar: { kind: 'fallback', policy: 'work-cover-v1', key: 'work', resourceType: 'work' } }] as unknown as
    Awaited<ReturnType<WorkReadSession['summaries']>>;
  return session;
}

test('external-author first page and Works page preserve deleted and active coauthor identity', async () => {
  const first = await readExternalAuthor(fixture(), key);
  const page = await readExternalAuthorWorks(fixture(), key);
  expect(Value.Check(externalAuthorRead, first)).toBe(true);
  expect(Value.Check(authorWorksPage, page)).toBe(true);
  for (const items of [first.works.items, page.items]) {
    expect(items[0]?.authors).toEqual([
      { kind: 'agent', agent: deleted, identityStatus: 'deleted', displayName: 'Deleted author', handle: null },
      { kind: 'agent', agent: live, identityStatus: 'active', displayName: 'Continuing author', handle: 'continuing-author' },
      { kind: 'external', provider: 'open-library', key, displayName: null },
    ]);
    const neutral = items[0]!.authors[0]!;
    if (neutral.kind !== 'agent') throw new Error('Deleted coauthor is not an Agent credit');
    for (const field of ['address', 'avatar', 'avatarUrl', 'links', 'bio']) expect(neutral).not.toHaveProperty(field);
    const unclassified = { kind: neutral.kind, agent: neutral.agent,
      displayName: neutral.displayName, handle: neutral.handle };
    expect(Value.Check(authorCredit, unclassified)).toBe(false);
  }
});

test('an unavailable coauthor without a Person tombstone stays absent from external-author Works', async () => {
  const page = await readExternalAuthorWorks(fixture(false), key);
  expect(page.items[0]?.authors).toEqual([
    { kind: 'agent', agent: live, identityStatus: 'active', displayName: 'Continuing author', handle: 'continuing-author' },
    { kind: 'external', provider: 'open-library', key, displayName: null },
  ]);
});

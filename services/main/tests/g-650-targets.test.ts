import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Value } from 'typebox/value';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { reviewCommand } from '../src/modules/review/contract.ts';
import { reviewTarget } from '../src/modules/review/read.ts';
import { replyRoot, readReplyRoot, publicReplyRoot } from '../src/modules/realm-reply/root.ts';
import { readWorkDiscussion, readWorkActivityHistory } from '../src/modules/work-activity/read.ts';
import { readWorkRatingContexts, readWorkRating } from '../src/modules/work/read-rating.ts';
import { WorkReadSession, WorkReadMoved, WorkReadMissing, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { TargetNotBound, TargetUnavailable, resolveTargets, targetSummaryReader, type ReportTargets } from '../src/modules/target/resolve.ts';
import { workReadError } from '../src/routes/work-reads.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { structureProfileFor, canReadStructureTarget } from '../src/modules/structure/profiles.ts';
import { checkedOperations } from '../src/modules/structure/change.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const directory = mkdtempSync('.temp/g-650-unit-');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture(type: 'work' | 'release' | 'occurrence' | 'character' | 'realization', options: {
  public?: boolean; allowed?: boolean; draft?: boolean; moved?: boolean; erasedRoot?: boolean } = {}) {
  const queries: string[] = [];
  const graph = new FusekiClient('http://graph.invalid');
  const semanticManifest = prepareComponent(directory, id(1), { component: 'resource', lifecycle: 'active',
    types: [`${RV}Character`], properties: [{ predicate: 'https://schema.org/name',
      value: { kind: 'language-string', lexical: 'Kirito', language: 'en' } }] }, PROFILES.resource);
  graph.query = async query => {
    queries.push(query);
    let rows: Row[];
    if (query.includes('SELECT ?epoch ?sequence ?hold')) rows = [{ epoch: literal('epoch'),
      sequence: literal('1'), r: uri(id(1)), type: literal(type), head: uri(id(2)),
      ...(type !== 'character' ? { work: uri(type === 'work' ? id(1) : id(10)) } : {}),
      public: literal(String(options.public ?? true)), erased: literal('false'),
      label: { type: 'literal', value: 'SAO', 'xml:lang': 'en' } }];
    else if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) rows = [{ epoch: literal('epoch'),
      sequence: literal(options.moved ? '2' : '1'), r: uri(id(1)), revision: uri(id(2)),
      type: uri('https://example.test/DescriptiveType') }];
    else if (query.includes('SELECT ?epoch ?sequence WHERE')) rows = [{ epoch: literal('epoch'), sequence: literal('1') }];
    else if (query.includes('SELECT DISTINCT ?main ?realm')) rows = [{ main: uri(id(3)) }];
    else if (query.includes('SELECT ?main WHERE')) rows = [{ main: uri(id(3)) }];
    else if (query.includes('SELECT ?decision WHERE')) rows = options.draft ? [{ decision: uri(id(4)) }] : [];
    else if (query.includes('SELECT ?root WHERE')) rows = options.erasedRoot ? [] : [{ root: uri(id(9)) }];
    else if (query.includes('SELECT ?context')) rows = [];
    else if (query.includes('SELECT ?grain WHERE')) rows = [];
    else if (query.includes('SELECT ?resource ?manifest')) rows = [{ resource: uri(id(1)),
      manifest: uri(`urn:rezics:sha256:${semanticManifest}`) }];
    else throw new Error(`Unexpected query: ${query}`);
    return { results: { bindings: rows } };
  };
  const deps: MainWorkDependencies = { environment: { fuseki: graph, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } }, account: {} as never,
    access: { canReadWork: async () => options.allowed ?? false,
      canReadSemanticResource: async () => options.allowed ?? false } as never };
  const session = new WorkReadSession(deps, new Request('http://main.local/v1/resources'),
    { actingSubject: id(99) }, { dataEpoch: 'epoch', sequence: '1' });
  session.principal = { issuer: 'https://account.test', subject: 'reader' };
  return { graph, session, queries, deps };
}

test('G-650: four resource reads replace Work aliases and review commands name target', async () => {
  const f = fixture('work');
  const app = createMainApp(f.graph, f.deps);
  const paths = new Set(app.routes.filter(route => route.method === 'GET').map(route => route.path));
  for (const read of ['reviews', 'ratings', 'rating-contexts', 'discussion']) {
    expect(paths.has(`/v1/resources/:resource/${read}`)).toBe(true);
    expect(paths.has(`/v1/works/:id/${read}`)).toBe(false);
    expect((await app.handle(new Request(`http://main.local/v1/works/${id(1).slice(-36)}/${read}`))).status).toBe(404);
  }
  const command = { profile: 'reader-review-command-v1', actingSubject: id(99), context: id(5),
    target: id(1), expectedRevision: null, language: 'en', text: 'A review', spoiler: false };
  expect(Value.Check(reviewCommand, command)).toBe(true);
  const { target, ...rest } = command;
  expect(Value.Check(reviewCommand, { ...rest, work: target })).toBe(false);
});

test('G-650: reviews and rating reads retain MainVersion grain without a published-text gate', async () => {
  const f = fixture('work');
  expect(await reviewTarget(f.session, id(5), id(1))).toEqual({ mainVersion: id(3), realm: null, generic: false });
  expect((await readWorkRatingContexts(f.session, id(1))).items).toEqual([]);
  expect(await readWorkRating(f.session, id(1))).toMatchObject({ mainVersion: id(3), status: 'no-context' });
  expect(f.queries.filter(query => !query.includes('SELECT ?epoch ?sequence ?hold')).join('\n'))
    .not.toContain('rv:selectionHead');
  const release = fixture('release');
  await expect(reviewTarget(release.session, id(5), id(1))).rejects.toBeInstanceOf(TargetNotBound);
  await expect(readWorkRating(release.session, id(1))).rejects.toBeInstanceOf(TargetNotBound);
  expect(workReadError(new TargetNotBound()).status).toBe(422);
  expect(await workReadError(new TargetNotBound()).json()).toMatchObject({ code: 'target_not_bound' });
});

test('G-650: exact occurrence, release, character and metadata Work roots preserve resource identity', async () => {
  for (const type of ['work', 'release', 'occurrence', 'character'] as const) {
    const f = fixture(type, { allowed: true });
    expect(await replyRoot(f.session, id(1), id(2))).toBe(true);
    expect(await replyRoot(f.session, id(1), id(9))).toBe(false);
    expect(await replyRoot(f.session, id(1), 'invalid')).toBe(false);
    expect(f.queries.some(query => query.includes(`VALUES ?r { <${id(1)}> }`))).toBe(true);
  }
  const published = fixture('work', { draft: true });
  expect(await replyRoot(published.session, id(1), id(9))).toBe(true);
  expect(published.queries.at(-1)).toContain('rv:disclosure rv:Public');
});

test('G-650: anonymous private occurrences, erased/unavailable roots and moved snapshots fail closed', async () => {
  const privateRoot = fixture('occurrence', { public: false });
  expect(await publicReplyRoot(privateRoot.graph, id(1), id(2))).toBe(false);
  await expect(replyRoot(privateRoot.session, id(1), id(2))).rejects.toBeInstanceOf(TargetUnavailable);
  await expect(readWorkDiscussion(privateRoot.session, id(1))).rejects.toBeInstanceOf(TargetUnavailable);
  expect(privateRoot.queries.some(query => query.includes('RealmReplySlot'))).toBe(false);
  const moved = fixture('release', { moved: true });
  await expect(replyRoot(moved.session, id(1), id(2))).rejects.toBeInstanceOf(WorkReadMoved);
});

test('G-650: Collection membership resolves resources without a Content selection', async () => {
  const profile = structureProfileFor('collection-membership');
  for (const type of ['work', 'release', 'occurrence', 'character'] as const) {
    const f = fixture(type, { allowed: true });
    expect(await canReadStructureTarget(profile, { access: f.deps.access,
      principal: f.session.principal!, actingSubject: id(99), target: id(1),
      targetReader: operation => operation(f.session) })).toBe(true);
    const [operation] = checkedOperations([{ op: 'insert', parent: id(6), position: 'last',
      role: 'member', target: id(1) }], profile);
    expect(operation).toMatchObject({ op: 'insert', target: id(1) });
    expect(operation && 'selection' in operation).toBe(false);
  }
  const hidden = fixture('occurrence', { public: false });
  expect(await canReadStructureTarget(profile, { access: hidden.deps.access,
    principal: hidden.session.principal!, actingSubject: id(99), target: id(1),
    targetReader: operation => operation(hidden.session) })).toBe(false);
  const contentRevision = 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000002';
  const [pinned] = checkedOperations([{ op: 'insert', parent: id(6), position: 'last',
    role: 'member', target: id(1), selection: { mode: 'fixed-revision', revision: contentRevision } }], profile);
  expect(pinned).toMatchObject({ selection: { mode: 'fixed-revision', revision: contentRevision } });
});

test('G-650: retained roots survive target edits while new replies require current roots', async () => {
  for (const type of ['work', 'release', 'occurrence', 'character'] as const) {
    const f = fixture(type, { allowed: true });
    expect(await replyRoot(f.session, id(1), id(9))).toBe(false);
    expect(await readReplyRoot(f.session, id(1), id(9))).toBe(true);
    const erased = fixture(type, { allowed: true, erasedRoot: true });
    expect(await readReplyRoot(erased.session, id(1), id(9))).toBe(false);
  }
});

test('G-650: Work history rejects readable non-Work targets', async () => {
  for (const type of ['release', 'occurrence', 'character'] as const) {
    await expect(readWorkActivityHistory(fixture(type, { allowed: true }).session, id(1)))
      .rejects.toBeInstanceOf(WorkReadMissing);
  }
});


test('G-650: generalized sessions preserve report-owner resolution and duplicate order', async () => {
  const f = fixture('work', { allowed: true });
  const owned = { resource: id(5), base: 'resource' as const, work: null,
    revision: id(6), types: [`${RV}Realm`], disclosure: 'public' as const };
  const reportOwners: ReportTargets = async (session, resources) => {
    expect(session).toBe(f.session);
    expect(typeof session.realm).toBe('function');
    expect(resources).toEqual([id(5), id(1)]);
    return new Map([[id(5), owned]]);
  };
  const targets = await resolveTargets(f.session, [id(5), id(1), id(5)], 'report', undefined, reportOwners);
  expect(targets.map(target => target.resource)).toEqual([id(5), id(1), id(5)]);
  expect(targets[0]).toEqual(owned);
  expect(targets[2]).toEqual(owned);
  expect(targets[1]).toMatchObject({ base: 'work', revision: id(2) });
  await expect(resolveTargets(f.session, [id(1)], 'report', undefined,
    async () => new Map([[id(5), owned]]))).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(await targetSummaryReader(f.session).canReadWork!(id(1))).toBe(true);
});

test('G-650: native realization and published-text revision paths remain available to discussions', async () => {
  const f = fixture('realization', { allowed: true });
  expect(await replyRoot(f.session, id(1), id(2))).toBe(true);
  const revisionQuery = f.queries.find(query => query.includes('SELECT ?epoch ?sequence ?r ?revision'))!;
  expect(revisionQuery).toContain('rv:Realization ; rv:head ?revision');
  expect(revisionQuery).toContain('rv:RealizationRevision ; rv:component ?r');
  expect(revisionQuery).toContain('rv:TextContribution ; rv:publicationHead ?publication');
  expect(revisionQuery).toContain('rv:selectedDraft ?revision');
  expect(await readReplyRoot(f.session, id(1), id(9))).toBe(true);
});

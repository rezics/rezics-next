import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { resolvedTarget } from '../src/modules/target/contract.ts';
import { resolveCommandTarget, resolveTargets, targetSummaries, TargetNotBound, TargetUnavailable,
  type TargetReadSession } from '../src/modules/target/resolve.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { RV } from '../src/modules/work/activate.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { zoneHomeTargetFixture, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

test('home command identity uses the native published P/H grain without Content hydration', async () => {
  const h = zoneHomeTargetFixture();
  const position = { dataEpoch: 'epoch', sequence: '9' };
  const session = { checkDeadline() {}, position, query: async (query: string, limit: number) => {
    expect(limit).toBe(64);
    expect(query).toContain('rv:homeDocumentHead ?revision');
    expect(query).toContain('a rv:ZoneHomeRevision, rv:RevisionAnchor');
    expect(query).toContain('rv:homeRevision ?revision');
    expect(query).toContain('rv:outcome rv:Succeeded');
    expect(query).toContain('rv:ErasedRevision');
    expect(query).not.toContain('rv:contentRevision');
    expect(query).not.toContain('rdfs:label');
    return [{ epoch: cell(position.dataEpoch), sequence: cell(position.sequence),
      r: cell(h.resource), base: cell('resource'), revision: cell(h.revision),
      type: cell('https://rezics.com/vocab/ZoneHomeDocument') }];
  } } as unknown as TargetReadSession;
  expect(await resolveCommandTarget(session, h.resource)).toEqual({ resource: h.resource,
    revision: h.revision, base: 'resource', work: null, disclosure: 'restricted',
    types: ['https://rezics.com/vocab/ZoneHomeDocument'] });
});

function publishedResolver() {
  const h = zoneHomeTargetFixture();
  const position = { dataEpoch: h.env.lineage.dataEpoch, sequence: '9' };
  const state = { published: true, erased: false, absent: false, revision: h.revision,
    sequence: '9', duplicateHead: false, moveDuringHeads: false, summaryConflict: false, includePost: false };
  const graph = h.env.fuseki.query.bind(h.env.fuseki);
  h.env.fuseki.query = async (query, budget) => {
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      h.queries.push(query);
      // This owner adapter only emits home rows when the actual native branch is present.
      expect(query).toContain('?r a rv:ZoneHomeDocument ; rv:homeDocumentHead ?head');
      expect(query).toContain('rv:homeRevision ?head');
      expect(query).toContain('rv:outcome rv:Succeeded');
      expect(query).not.toContain('OPTIONAL { FILTER(BOUND(?homeZone))');
      const control = { epoch: cell(position.dataEpoch), sequence: cell(state.sequence) };
      const row = { ...control, r: cell(h.resource),
        hasCurrentIdentity: cell(String(!state.absent)), ...(state.published && !state.absent ? {
          type: cell('resource'), head: cell(h.revision), homeZone: cell(h.zone), public: cell('false'),
          erased: cell(String(state.erased)), label: { ...cell('Home'), 'xml:lang': 'en' },
        } : {}) };
      return { results: { bindings: [row,
        ...(state.summaryConflict ? [{ ...row, head: cell(h.siteRevision) }] : []),
        ...(state.includePost ? [{ ...control, r: cell(h.space), type: cell('resource'), post: cell('true'),
          public: cell('true'), head: cell(h.siteRevision), hasCurrentIdentity: cell('true'),
          label: { ...cell('Other page'), 'xml:lang': 'en' } }] : []),
      ] } };
    }
    return graph(query, budget);
  };
  const principal = { issuer: 'account', subject: 'reader' };
  const authority: string[] = [];
  const access = {
    canReadWork: async () => { throw new Error('Home targets cannot use Work readability'); },
    canReadSemanticResource: async (_principal: unknown, _actor: unknown, resource: string) => {
      authority.push(resource); return false;
    }, realmReadProof: async () => null as string | null,
  };
  const session = { checkDeadline() {}, position, request: new Request('http://main.local/v1/resources'),
    options: {}, principal: null, displayLanguages: ['en'], viewer: ANONYMOUS_VIEWER,
    deps: { environment: h.env, access }, query: async (query: string) => {
      h.queries.push(query);
      expect(query).toContain('rv:homeDocumentHead ?revision');
      const control = { epoch: cell(position.dataEpoch), sequence: cell(state.moveDuringHeads ? '10' : state.sequence) };
      const row = { ...control, r: cell(h.resource), revision: cell(state.revision),
        type: cell(`${RV}ZoneHomeDocument`) };
      return state.duplicateHead ? [row, { ...row, revision: cell(h.siteRevision) }] : [row];
    } } as unknown as TargetReadSession;
  return { ...h, session, state, principal, authority, access };
}

// Trust condition 1: the reader resolver returns only the owner's exact published P/H selections.
test('public home resolves through real summaries as a Resource with exact multilingual H selections', async () => {
  const h = publishedResolver();
  expect(await resolveTargets(h.session, [h.resource], 'report')).toEqual([{
    resource: h.resource, base: 'resource', work: null, revision: h.revision,
    types: [`${RV}ZoneHomeDocument`], disclosure: 'public', contentSelections: h.selections,
  }]);
  expect(h.authority).toEqual([]);
  expect(h.policyTargets.flat().filter(target => target.component === 'record')
    .every(target => target.resource === h.resource && target.revision === h.revision)).toBe(true);
});

test('public home summary remains public for a signed reader and keeps its /e/ address', async () => {
  const h = publishedResolver();
  h.session.principal = h.principal;
  h.session.options.actingSubject = h.author;
  h.session.viewer = { ...ANONYMOUS_VIEWER, signedIn: true };
  const batch = await targetSummaries(h.session, [h.resource]);
  expect(batch.summaries[0]).toMatchObject({ reference: h.resource, status: 'available',
    type: 'resource', base: 'resource', work: null, disclosure: 'public', address: { prefix: '/e/' } });
  expect(h.policyTargets.flat().filter(target => target.component === 'record')).toHaveLength(3);
});

test('native home visibility follows its publication owner rather than a copied Zone disclosure flag', async () => {
  const h = publishedResolver();
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  expect((await resolveTargets(h.session, [h.resource], 'report'))[0]!.disclosure).toBe('public');
  expect(h.authority).toEqual([]);
});

// Trust condition 3: a private home needs the owning Zone's live authority, never a grant on P.
test('private home resolves only with live owning Zone read authority and reports restricted visibility', async () => {
  const h = publishedResolver();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  await expect(resolveTargets(h.session, [h.resource], 'report')).rejects.toBeInstanceOf(TargetUnavailable);
  h.authority.length = 0;
  h.session.principal = h.principal;
  h.session.options.actingSubject = h.author;
  h.session.viewer = { ...ANONYMOUS_VIEWER, signedIn: true };
  h.access.canReadSemanticResource = async (_principal, _actor, resource) => {
    h.authority.push(resource); return resource === h.zone;
  };
  expect((await resolveTargets(h.session, [h.resource], 'report'))[0]).toMatchObject({
    resource: h.resource, base: 'resource', work: null, revision: h.revision,
    disclosure: 'restricted', contentSelections: h.selections,
  });
  expect(h.authority).toEqual([h.zone, h.zone, h.zone]);
});

test('draft, erased and foreign home cuts never resolve as current published targets', async () => {
  for (const condition of ['draft', 'erased', 'foreign'] as const) {
    const h = publishedResolver();
    if (condition === 'draft') h.state.published = false;
    if (condition === 'erased') h.state.erased = true;
    if (condition === 'foreign') h.cutRows.length = 0;
    await expect(resolveTargets(h.session, [h.resource], 'report')).rejects.toBeInstanceOf(TargetUnavailable);
  }
});

test('home resolution rejects ambiguous native heads and moving graph positions', async () => {
  const h = publishedResolver();
  h.state.duplicateHead = true;
  await expect(resolveTargets(h.session, [h.resource], 'report')).rejects.toBeInstanceOf(WorkReadUnavailable);
  h.state.duplicateHead = false;
  h.state.moveDuringHeads = true;
  await expect(resolveTargets(h.session, [h.resource], 'report')).rejects.toBeInstanceOf(WorkReadMoved);
  h.state.moveDuringHeads = false;
  h.state.sequence = '10';
  await expect(resolveTargets(h.session, [h.resource], 'report')).rejects.toBeInstanceOf(WorkReadMoved);
});

test('home summary refuses conflicting H ownership before names can be delivered', async () => {
  const h = publishedResolver();
  h.state.summaryConflict = true;
  expect((await targetSummaries(h.session, [h.resource])).summaries).toEqual([
    { reference: h.resource, status: 'unavailable' },
  ]);
});

test('home label hydration stays in its native owner branch and other Resources keep serving', async () => {
  const h = publishedResolver();
  h.state.includePost = true;
  const batch = await targetSummaries(h.session, [h.resource, h.space]);
  expect(batch.summaries).toMatchObject([
    { reference: h.resource, status: 'available', base: 'resource', name: { value: 'Home' } },
    { reference: h.space, status: 'available', base: 'resource', name: { value: 'Other page' } },
  ]);
});

test('private Realm home resolution keeps membership independent of a Zone-only read grant', async () => {
  const h = publishedResolver();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.realm = cell(h.siteRevision);
  h.session.principal = h.principal;
  h.session.options.actingSubject = h.author;
  h.access.canReadSemanticResource = async () => true;
  await expect(resolveTargets(h.session, [h.resource], 'report')).rejects.toBeInstanceOf(TargetUnavailable);
  h.access.realmReadProof = async () => 'live-membership';
  expect((await resolveTargets(h.session, [h.resource], 'report'))[0]).toMatchObject({
    resource: h.resource, revision: h.revision, disclosure: 'restricted', contentSelections: h.selections,
  });
});

test('home summary refences Zone authority after hydration and hides revocation', async () => {
  const h = publishedResolver();
  h.visibilityRows[0]!.disclosure = cell(`${RV}Private`);
  h.visibilityRows[0]!.zoneDisclosure = cell(`${RV}Private`);
  h.session.principal = h.principal;
  h.session.options.actingSubject = h.author;
  let probes = 0, hydrated = 0, readable = true;
  h.access.canReadSemanticResource = async (_principal, _actor, resource) => {
    probes++; return resource === h.zone && readable;
  };
  h.session.deps.media = { store: { avatarRows: async () => {
    hydrated++; readable = false; return null;
  } } } as unknown as NonNullable<TargetReadSession['deps']['media']>;
  expect((await targetSummaries(h.session, [h.resource])).summaries).toEqual([
    { reference: h.resource, status: 'unavailable' },
  ]);
  expect(probes).toBe(2);
  expect(hydrated).toBe(1);
});

// Trust condition 2: a P/H restriction and an absent identity share the summary answer and cost shape.
test('restricted home summaries match absent summaries for signed and anonymous readers', async () => {
  for (const signedIn of [false, true]) {
    const h = publishedResolver();
    h.session.viewer = { ...ANONYMOUS_VIEWER, signedIn };
    configureDisclosure(h.env, { read: async targets => targets.map(target => target.component === 'record' ? 'hidden' : 'visible') });
    const hidden = await targetSummaries(h.session, [h.resource]);
    h.state.absent = true;
    const absent = await targetSummaries(h.session, [h.resource]);
    expect(hidden).toEqual(absent);
  }
});

test('home audience admission denies capabilities outside the current report and moderation binding', async () => {
  const h = publishedResolver();
  await expect(resolveTargets(h.session, [h.resource], 'review')).rejects.toBeInstanceOf(TargetNotBound);
});

test('home command identity refuses absent, competing and moving native cuts', async () => {
  const h = zoneHomeTargetFixture(), position = { dataEpoch: 'epoch', sequence: '9' };
  const row = { epoch: cell(position.dataEpoch), sequence: cell(position.sequence),
    r: cell(h.resource), base: cell('resource'), revision: cell(h.revision),
    type: cell('https://rezics.com/vocab/ZoneHomeDocument') };
  const session = (rows: object[]) => ({ checkDeadline() {}, position,
    query: async () => rows }) as unknown as TargetReadSession;
  await expect(resolveCommandTarget(session([{ epoch: row.epoch, sequence: row.sequence }]), h.resource))
    .rejects.toBeInstanceOf(TargetUnavailable);
  await expect(resolveCommandTarget(session([row, { ...row, revision: cell(h.siteRevision) }]), h.resource))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(resolveCommandTarget(session([{ ...row, sequence: cell('10') }]), h.resource))
    .rejects.toBeInstanceOf(WorkReadMoved);
});

test('resolved home contract carries bounded exact variant, Content revision and digest selections', () => {
  const h = zoneHomeTargetFixture();
  const target = { resource: h.resource, revision: h.revision, base: 'resource', work: null,
    disclosure: 'public', types: ['https://rezics.com/vocab/ZoneHomeDocument'], contentSelections: h.selections };
  expect(Value.Check(resolvedTarget, target)).toBe(true);
  for (const contentSelections of [[], Array.from({ length: 33 }, () => h.selections[0]),
    [{ ...h.selections[0], byteDigest: 'unretained' }],
    [{ ...h.selections[0], variantId: h.resource }], [{ ...h.selections[0], revisionId: h.revision }]]) {
    expect(Value.Check(resolvedTarget, { ...target, contentSelections })).toBe(false);
  }
});

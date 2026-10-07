import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { configureDisclosure, DisclosureStore } from '../../../services/main/src/modules/disclosure/read.ts';
import { disclosureViewer } from '../../../services/main/src/modules/disclosure/viewer.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { RELEASE_QUERY_COST } from '../../../services/main/src/modules/facets/release-contract.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';
import type { ReleaseV2Write } from '../../../services/main/src/modules/release/schema.ts';
import { readResourceSummaries } from '../../../services/main/src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { DEFAULT_PERSON_CHOICES, PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

test('signed-in and anonymous Realm release queries retain both current summary checks within twelve graph calls', async () => {
  const s = await startMediaStack('media-summary-disclosure-release');
  const originalQuery = s.fuseki.query.bind(s.fuseki);
  try {
    const editor = await s.member('release-reader');
    const principal = { ...editor.principal, emailVerified: true };
    const work = await s.publicWork(editor.actor, ['en'], 'Bounded signed-in release browse');
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const realization: RealizationWrite = { profile: 'realization-v1', id: id(), expectedHead: null,
      actingSubject: editor.actor, language: 'en', kind: 'translation', translators: [editor.actor],
      publishers: [editor.actor], source: { kind: 'unresolved', work: work.work },
      status: 'official', verification: 'verified', evidence: id() };
    const saved = await json<{ revision: string }>(await editor.send('PUT',
      `/v1/works/${work.work.slice(-36)}/realizations/${realization.id.slice(-36)}`, realization));
    const release: ReleaseV2Write = { profile: 'release-v2', id: id(), expectedHead: null,
      actingSubject: editor.actor, kind: 'formal', status: 'official',
      title: { value: 'English Windows release', language: 'en' }, titleLanguage: 'en',
      tracklistLanguage: null, editionStatement: null, publisher: null, publicationYear: null,
      isbn13: null, originalUrl: null, fixedRelease: null, evidence: null, identifiers: [],
      platform: 'Windows', territory: 'US',
      coverage: [{ realization: realization.id, revision: saved.revision, completeness: 'complete' }] };
    await json(await editor.send('PUT',
      `/v1/works/${work.work.slice(-36)}/releases/${release.id.slice(-36)}`, release));
    const input = { name: 'Release summary disclosure', actingSubject: editor.actor };
    const created = await createRealmSpace(s.env, s.admission(editor.actor, 'space:create:root',
      'space.create', spaceCreationDigest(input)), input);
    if (created.outcome !== 'succeeded' || !created.realm) throw new Error('Realm fixture failed');
    const realm = created.realm, slot = id(), selection = id();
    // The Realm adopts the exact existing public Main selection witness.
    await s.fuseki.update(`PREFIX rv: <${RV}> INSERT {
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
        rv:work ${iri(work.work)} ; rv:mainVersion ${iri(work.mainVersion)} ; rv:selectionHead ${iri(selection)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection)} a rv:PublicationSelection ; rv:component ${iri(slot)} ;
        rv:context ${iri(realm)} ; rv:work ${iri(work.work)} ; rv:mainVersion ${iri(work.mainVersion)} ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft }
    } WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work.mainVersion)} rv:selectionHead ?head }
      GRAPH ${iri(GRAPHS.revisions)} { ?head rv:contribution ?contribution ;
        rv:publicationDecision ?decision ; rv:selectedDraft ?draft }
    }`);
    const preferences = new PersonPreferencesStore(s.accessPool);
    const app = createMainApp(s.fuseki, { environment: s.env, access: s.access,
      media: s.media, agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      personPreferences: preferences, account: { verify: async () => principal } });
    let statements = 0;
    const pool = new Proxy(s.accessPool, { get(target, property) {
      if (property === 'query') return async (...args: unknown[]) => {
        if (String(args[0]).includes('requested AS')) statements++;
        return Reflect.apply(target.query, target, args);
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    configureDisclosure(s.env, new DisclosureStore(pool));
    const body = { context: { realm }, scope: { kind: 'realm', realm }, sort: 'newest', page: { size: 20 },
      filter: { all: [{ facet: 'release', where: { all: [
        { facet: 'releaseLanguage', any: ['en'] }, { facet: 'releasePlatform', any: ['Windows'] },
        { facet: 'releaseCompleteness', any: ['complete'] }, { facet: 'releaseStatus', any: ['official'] },
      ] } }] } };
    type Result = { result: { items: { id: string; matchedReleases: string[] }[] } };
    const read = async (signedIn: boolean) => {
      const budgets = new Map<NonNullable<ReturnType<typeof fusekiReadBudget.getStore>>, number>();
      let ownerProbes = 0;
      s.fuseki.query = (query, maxBytes) => {
        const budget = fusekiReadBudget.getStore();
        if (budget) budgets.set(budget, (budgets.get(budget) ?? 0) + 1);
        if (query.includes('SELECT ?work ?head ?nameOwner')) ownerProbes++;
        return originalQuery(query, maxBytes);
      };
      const before = statements;
      const result = await json<Result>(await app.handle(new Request('http://main.local/v1/query', {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(signedIn ? { authorization: `Bearer ${editor.token}` } : {}) }, body: JSON.stringify(body),
      })));
      expect(result.result.items).toEqual([expect.objectContaining({ id: work.work, matchedReleases: [release.id] })]);
      // Outer Work position fences have their own ledger; every summary probe
      // and the Realm release read debit this unchanged twelve-call allocation.
      const calls = Math.max(...budgets.values());
      expect(RELEASE_QUERY_COST.graphCalls).toBe(12);
      expect(calls).toBeLessThanOrEqual(RELEASE_QUERY_COST.graphCalls);
      expect(ownerProbes).toBe(4);
      expect(statements - before).toBe(4);
      return { items: result.result.items, calls };
    };
    const anonymous = await read(false), signedIn = await read(true);
    expect(signedIn).toEqual(anonymous);
    expect(signedIn.calls).toBe(11);
    s.fuseki.query = originalQuery;

    const provisioned = await json<{ agent: string }>(await app.handle(new Request('http://main.local/v1/agents', {
      method: 'POST', headers: { authorization: `Bearer ${editor.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'agent-provision-v1', kind: 'person', displayName: 'Private summary name' }),
    })), 201);
    const viewer = disclosureViewer(principal, provisioned.agent);
    const summaryInput = { resources: [provisioned.agent], context: DEFAULT_MEDIA_CONTEXT, language: null };
    await preferences.write(principal, provisioned.agent,
      { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' }, 0, randomUUID());
    expect((await readResourceSummaries(s.env, undefined, { viewer }, summaryInput)).summaries[0])
      .toMatchObject({ status: 'available', disclosure: 'restricted', name: { value: 'Private summary name' } });
    for (const reader of [{}, { viewer: disclosureViewer({ ...principal, subject: 'unrelated-reader' }) }]) {
      expect((await readResourceSummaries(s.env, undefined, reader, summaryInput)).summaries)
        .toEqual([{ reference: provisioned.agent, status: 'unavailable' }]);
    }
    await preferences.write(principal, provisioned.agent, DEFAULT_PERSON_CHOICES, 1, randomUUID());
    const hydrated = await readResourceSummaries(s.env, { avatarRows: async () => {
      await preferences.write(principal, provisioned.agent,
        { ...DEFAULT_PERSON_CHOICES, profileVisibility: 'private' }, 2, randomUUID());
      return null;
    } }, { viewer }, summaryInput);
    expect(hydrated.summaries[0]).toMatchObject({ status: 'available', disclosure: 'restricted' });
    const revoked = await readResourceSummaries(s.env, { avatarRows: async () => {
      await s.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [editor.principalId]);
      return null;
    } }, { viewer }, summaryInput);
    expect(revoked.summaries).toEqual([{ reference: provisioned.agent, status: 'unavailable' }]);
  } finally {
    s.fuseki.query = originalQuery;
    await s.stop();
  }
}, 180_000);

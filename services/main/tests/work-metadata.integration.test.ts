import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { GRAPHS, RV, iri, lit } from '../src/modules/work/activate.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch } from '../src/modules/outbox/relay.ts';
import { METADATA_PROFILE, type MetadataEditionState, type MetadataHeaderState, type MetadataState } from '../src/modules/work/metadata-schema.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
interface Receipt { revision: string; receipt: string; replayed: boolean; sourcePosition: { dataEpoch: string; sequence: string } }
interface Page<T> { items: T[]; nextCursor: string | null; count: { value: number; kind: string; total: null } }
interface Header { revision: string; metadataRevision: string | null; originalTitle: { value: string; language: string } | null;
  title: { value: string; language: string; basis: string }; description: { value: string } | null }
const metadata: MetadataHeaderState = { kind: 'header', originalTitle: { value: '銀河の旅', language: 'ja' },
  completionStatus: 'ongoing',
  localized: [{ language: 'ja', title: '銀河の旅', description: '記録された説明', mainVersionLabel: '本文',
    tagline: '星を越えて届く一通の手紙' },
    { language: 'en', title: 'A Galactic Journey', description: 'Recorded synopsis', mainVersionLabel: 'Main text',
      tagline: 'A letter crosses the stars' }] };
const edition = (editionId = id()): MetadataEditionState => ({ kind: 'edition', id: editionId, status: 'active',
  title: { value: 'A Galactic Journey', language: 'en' }, contentLanguage: 'en', editionStatement: 'Second edition',
  publisher: 'Recorded publisher', publicationYear: 2001, isbn13: '9780306406157' });

test('Work metadata: native writes, disclosure, editions, relevance, concurrent CAS and lost-response recovery', async () => {
  const stack = await startMediaStack('work-metadata');
  try {
    const a = await stack.member('metadata-editor'), b = await stack.member('metadata-outsider');
    const work = await stack.publicWork(a.actor, ['en'], 'Legacy English display title');
    const privateWork = await stack.privateWork(a.actor, 'Private metadata');
    const root = `/v1/works/${work.work.slice(-36)}`;
    const privateRoot = `/v1/works/${privateWork.work.slice(-36)}`;
    await a.grant(`work:edit:${work.work}`, 'work.edit');
    await a.grant(`work:edit:${privateWork.work}`, 'work.edit');
    await a.grant(`work:read:${privateWork.work}`, 'work.read');
    const get = (path: string) => stack.call('GET', path);
    const body = (state: MetadataState, expectedHead: string | null = null) =>
      ({ profile: 'work-metadata-details-v1', state, expectedHead, actingSubject: a.actor });
    const put = (state: MetadataState, expectedHead: string | null = null, key = randomUUID()) =>
      a.send('PUT', `${root}/metadata`, body(state, expectedHead), key);
    const before = await json<Header>(await get(root));
    expect(before.originalTitle).toBeNull();
    expect(before.metadataRevision).toBeNull();
    expect(await json(await get(`${root}/metadata`))).toMatchObject({ revision: null, originalTitle: null, localized: [] });
    expect((await json<Page<unknown>>(await get(`${root}/editions`))).items).toEqual([]);
    expect((await b.send('PUT', `${root}/metadata`, { ...body(metadata), actingSubject: b.actor })).status).toBe(403);
    expect((await a.send('PUT', `${root}/metadata`, { ...body(metadata), expectedHead: undefined })).status).toBe(400);
    expect((await put({ ...edition(), isbn13: '9780306406158' })).status).toBe(400);
    const key = randomUUID();
    const saved = await json<Receipt>(await put(metadata, null, key));
    expect(saved.replayed).toBeFalse();
    const replay = await json<Receipt>(await put(metadata, null, key));
    expect(replay).toMatchObject({ revision: saved.revision, receipt: saved.receipt, replayed: true });
    expect((await put({ ...metadata, originalTitle: null }, null, key)).status).toBe(409);
    const afterQueries = stack.fuseki.queries;
    const header = await json<Header>(await get(`${root}?language=ja`));
    expect(stack.fuseki.queries - afterQueries).toBe(11);
    expect(header).toMatchObject({ revision: before.revision, metadataRevision: saved.revision,
      originalTitle: { value: '銀河の旅', language: 'ja' }, title: { value: '銀河の旅', language: 'ja', basis: 'requested' },
      description: { value: '記録された説明' }, tagline: { value: '星を越えて届く一通の手紙' },
      completionStatus: 'ongoing', mainVersionLabel: { value: '本文' } });
    expect(await json(await get(`${root}?language=fr`))).toMatchObject({
      originalTitle: { language: 'ja' }, title: { value: 'A Galactic Journey', language: 'en', basis: 'fallback' } });
    const batch = await readNextMainOutboxBatch(stack.fuseki, saved.sourcePosition.dataEpoch,
      (BigInt(saved.sourcePosition.sequence) - 1n).toString());
    expect(batch).not.toBeNull();
    const event = await readMainOutboxEnvelope(stack.fuseki, batch!, batch!.eventIds[0]!);
    expect(event).toMatchObject({ type: 'com.rezics.work.metadata-changed.v1',
      data: { receipt: { metadata: { work: work.work, revision: saved.revision } } } });

    // Independent editions preserve both the native text inventory and the Work title revision.
    const firstEdition = edition(), secondEdition = { ...edition(), contentLanguage: 'ja' };
    const first = await json<Receipt>(await put(firstEdition));
    const second = await json<Receipt>(await put(secondEdition));
    expect(await json(await get(`${root}/editions/${firstEdition.id.slice(-36)}`)))
      .toMatchObject({ id: firstEdition.id, revision: first.revision, status: 'active', record: firstEdition });
    expect((await get(`${privateRoot}/editions/${firstEdition.id.slice(-36)}`)).status).toBe(404);
    expect((await put(edition(before.revision))).status).toBe(409);
    const pageQueries = stack.fuseki.queries;
    const page = await json<Page<MetadataEditionState & { revision: string }>>(await get(`${root}/editions?limit=1`));
    expect(stack.fuseki.queries - pageQueries).toBe(17);
    expect(page.items.length).toBe(1);
    expect(page.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(page.nextCursor).toBeString();
    // The continuation belongs to this Work's editions, not another Work's write.
    await stack.privateWork(a.actor, 'An unrelated Work');
    const next = await json<Page<MetadataEditionState>>(await get(`${root}/editions?limit=1&cursor=${page.nextCursor}`));
    expect(new Set([...page.items, ...next.items].map(item => item.id)).size).toBe(2);
    expect(next.nextCursor).toBeNull();
    expect((await get(`${root}/editions?contentLanguage=en&cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await get(`${root}/editions?scope=mine`)).status).toBe(400);
    expect((await get(`${root}/editions?limit=21`)).status).toBe(400);
    expect((await json<Page<MetadataEditionState>>(await get(`${root}/editions?contentLanguage=ja`))).items)
      .toMatchObject([{ id: secondEdition.id, publicationYear: 2001, publisher: 'Recorded publisher' }]);
    expect((await json<Page<unknown>>(await get(`${root}/versions`))).items.length).toBe(1);
    const insertedEdition = edition();
    const inserted = await json<Receipt>(await put(insertedEdition));
    expect((await get(`${root}/editions?limit=1&cursor=${page.nextCursor}`)).status).toBe(409);
    await json<Receipt>(await put({ ...insertedEdition, status: 'withdrawn' }, inserted.revision));
    const v2Page = await json<Page<unknown>>(await get(`${root}/editions?limit=1`));
    const { contentLanguage: _contentLanguage, ...editionFields } = edition();
    const v2Edition = { ...editionFields, contentLanguages: ['en'], isTranslation: false,
      originalLanguages: [], titleLanguage: null, tracklistLanguage: null };
    const putV2 = (state: typeof v2Edition, expectedHead: string | null = null) =>
      a.send('PUT', `${root}/metadata`, { profile: 'work-metadata-details-v2', state, expectedHead, actingSubject: a.actor });
    const insertedV2 = await json<Receipt>(await putV2(v2Edition));
    expect((await get(`${root}/editions?limit=1&cursor=${v2Page.nextCursor}`)).status).toBe(409);
    await json<Receipt>(await putV2({ ...v2Edition, status: 'withdrawn' }, insertedV2.revision));
    const withdrawn = await json<Receipt>(await put({ ...firstEdition, status: 'withdrawn' }, first.revision));
    expect(await json(await get(`${root}/editions/${firstEdition.id.slice(-36)}`)))
      .toMatchObject({ id: firstEdition.id, revision: withdrawn.revision, status: 'withdrawn', record: null });
    expect((await get(`${root}/editions?cursor=${page.nextCursor}`)).status).toBe(409);
    expect((await json<Page<MetadataEditionState>>(await get(`${root}/editions`))).items.map(item => item.id))
      .toEqual([secondEdition.id]);
    expect((await a.send('PUT', `${privateRoot}/metadata`, body(firstEdition))).status).toBe(409);

    // Source damage withholds the complete page instead of silently dropping a candidate.
    const storedState = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?state WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(second.revision)} rv:metadataState ?state } }`)).results!.bindings[0]!.state!.value;
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(second.revision)} rv:metadataState ${lit(storedState)} } }`);
    try {
      expect((await get(`${root}/editions`)).status).toBe(503);
      expect((await get(`${root}/editions/${secondEdition.id.slice(-36)}`)).status).toBe(503);
    } finally {
      await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(second.revision)} rv:metadataState ${lit(storedState)} } }`);
    }

    const race = await Promise.all([
      put({ ...metadata, originalTitle: null }, saved.revision),
      put({ ...metadata, localized: [] }, saved.revision),
    ]);
    expect(race.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await json<Receipt>(race.find(response => response.status === 200)!);
    const staleKey = randomUUID();
    expect((await put(metadata, saved.revision, staleKey)).status).toBe(409);
    expect((await put(metadata, saved.revision, staleKey)).status).toBe(409);

    // The graph receipt resolves an HTTP response lost after durable commit.
    const command = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    let lost = false;
    stack.fuseki.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      if (!lost && envelope.update.includes('a rv:WorkMetadataRevision')) {
        lost = true;
        throw new Error('injected lost metadata commit response');
      }
      return result;
    };
    const recovered = await json<Receipt>(await put(metadata, winner.revision));
    expect(lost).toBeTrue();
    expect(recovered.replayed).toBeTrue();
    stack.fuseki.commandWithReceipt = command;
    const outcome = stack.access.recordGraphOutcome.bind(stack.access);
    let loseOutcome = true;
    stack.access.recordGraphOutcome = async (...args) => {
      if (loseOutcome) { loseOutcome = false; throw new Error('injected Access outcome unavailable'); }
      return outcome(...args);
    };
    const pendingKey = randomUUID();
    expect((await put({ ...metadata, originalTitle: null }, recovered.revision, pendingKey)).status).toBe(202);
    const retried = await json<Receipt>(await put({ ...metadata, originalTitle: null }, recovered.revision, pendingKey));
    expect(retried.replayed).toBeTrue();
    expect((await json<Header>(await get(`${root}?language=ja`))).originalTitle).toBeNull();
    stack.access.recordGraphOutcome = outcome;

    // A rejected persisted profile leaves the old head intact and is terminal on retry.
    stack.fuseki.commandWithReceipt = envelope => command(envelope.update.includes('a rv:WorkMetadataRevision')
      ? { ...envelope, update: envelope.update.replace(`rv:modelRevision <${METADATA_PROFILE}>`,
        'rv:modelRevision <urn:rezics:invalid-metadata-profile>') } : envelope);
    const invalidKey = randomUUID();
    expect((await put(metadata, retried.revision, invalidKey)).status).toBe(400);
    stack.fuseki.commandWithReceipt = command;
    expect((await put(metadata, retried.revision, invalidKey)).status).toBe(400);
    expect((await json<Header>(await get(root))).metadataRevision).toBe(retried.revision);

    await a.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string; space: string }>(await a.send('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Metadata Realm', capabilities: ['realm'], actingSubject: a.actor }), 201);
    await a.grant(`classification:context:${realm.realm}`, 'classification.context.configure');
    await a.grant(`classification:decide:${realm.realm}`, 'classification.decision.set');
    await json(await a.send('POST', '/v1/classification-contexts',
      { profile: 'classification-context-v1', realm: realm.realm, actingSubject: a.actor }), 201);
    await a.grant('classification:define:global', 'classification.proposition.define');
    await a.grant('classification:decide:global', 'classification.decision.set');
    const proposition = await json<{ sense: string }>(await a.send('POST', '/v1/classification-propositions',
      { profile: 'classification-proposition-v1', label: 'Space exploration', actingSubject: a.actor }), 201);
    const decisionInput = { profile: 'classification-direct-decision-v1', work: work.work, mainVersion: work.mainVersion,
      sense: proposition.sense, context: { kind: 'global' }, expectedDecisionHead: null, actingSubject: a.actor };
    const decision = await json<{ decision: string }>(await a.send('POST', '/v1/classification-decisions',
      { ...decisionInput, outcome: 'accepted' }), 201);
    const relevance = { kind: 'relevance' as const, sense: proposition.sense, context: { kind: 'global' as const },
      decision: decision.decision, level: 'central' as const };
    const relevanceWrite = await json<Receipt>(await put(relevance));
    const classifications = () => get(`${root}/classifications`);
    expect((await json<Page<unknown>>(await classifications())).items).toMatchObject([{ sense: proposition.sense,
      relevance: { level: 'central', policy: 'work-editor-topical-relevance-v1', basis: 'work-editor-assessment', revision: relevanceWrite.revision } }]);
    expect((await get(`${root}/classifications?scope=mine`)).status).toBe(401);
    expect((await a.read(`${root}/classifications?scope=mine`)).status).toBe(400);
    const realmPath = `${root}/classifications?scope=realm&realm=${encodeURIComponent(realm.realm)}`;
    expect((await json<Page<unknown>>(await get(realmPath))).items).toMatchObject([{ source: 'global', relevance: null }]);
    const realmRelevance = { ...relevance, context: { kind: 'realm-classification' as const, id: realm.realm },
      level: 'substantial' as const };
    await json(await put(realmRelevance));
    expect((await json<Page<unknown>>(await get(realmPath))).items).toMatchObject([{ relevance: { level: 'substantial' } }]);
    expect((await json<Page<unknown>>(await classifications())).items).toMatchObject([{ relevance: { level: 'central' } }]);
    await json(await a.send('POST', '/v1/classification-decisions', { ...decisionInput,
      context: realmRelevance.context, outcome: 'rejected' }), 201);
    expect((await json<Page<unknown>>(await get(realmPath))).items).toEqual([]);
    expect((await put(realmRelevance)).status).toBe(409);
    const revisedDecision = await json<{ decision: string }>(await a.send('POST', '/v1/classification-decisions',
      { ...decisionInput, expectedDecisionHead: decision.decision, outcome: 'accepted' }), 201);
    expect((await json<Page<unknown>>(await classifications())).items)
      .toMatchObject([{ relevance: null, relevanceStatus: 'stale', relevanceRevision: relevanceWrite.revision }]);

    await stack.fuseki.update(`PREFIX rv: <${RV}>
      DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(realm.space)} rv:disclosure rv:Public } };
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(realm.space)} rv:disclosure rv:Private } }`);
    expect((await get(realmPath)).status).toBe(404);
    expect((await a.read(realmPath)).status).toBe(404);
    expect((await put(relevance, relevanceWrite.revision)).status).toBe(409);
    const freshRelevance = await json<Receipt>(await put({ ...relevance, decision: revisedDecision.decision }, relevanceWrite.revision));
    await json(await put({ ...relevance, decision: revisedDecision.decision, level: null }, freshRelevance.revision));
    expect((await json<Page<unknown>>(await classifications())).items)
      .toMatchObject([{ relevance: null, relevanceStatus: 'withdrawn' }]);

    await json(await a.send('PUT', `${privateRoot}/metadata`, body(metadata)));
    for (const suffix of ['', '/metadata', '/editions']) {
      expect((await get(privateRoot + suffix)).status).toBe(404);
      expect((await b.read(privateRoot + suffix)).status).toBe(404);
      expect((await a.read(privateRoot + suffix)).status).toBe(200);
      expect((await get(`/v1/works/${randomUUID()}${suffix}`)).status).toBe(404);
    }
    const query = stack.fuseki.query.bind(stack.fuseki);
    let revoked = false;
    stack.fuseki.query = async (sparql, maxBytes) => {
      const response = await query(sparql, maxBytes);
      if (!revoked && sparql.includes('SELECT ?state WHERE')) {
        revoked = true;
        await stack.accessPool.query('UPDATE access.permission_grant SET valid_until = now() - interval \'1 second\' WHERE recipient_subject = $1 AND action = $2',
          [a.actor, 'work.read']);
      }
      return response;
    };
    expect((await a.read(`${privateRoot}/metadata`)).status).toBe(404);
    expect(revoked).toBeTrue();
    stack.fuseki.query = query;
    // Per-Work erasure/protection checks do not depend on metadata's own revision.
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`);
    for (const suffix of ['', '/metadata', '/editions', '/classifications']) {
      expect((await get(root + suffix)).status).toBe(404);
    }
    expect((await get(`${root}/editions/${secondEdition.id.slice(-36)}`)).status).toBe(404);
  } finally { await stack.stop(); }
}, 120_000);

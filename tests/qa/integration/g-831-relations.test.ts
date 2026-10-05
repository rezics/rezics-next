import { isForegroundOperation } from './support/operation-cost.ts';
import { expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { authorCreditFixture, author, nativeId, shortId } from '../fixtures/author-credit.ts';
import { relationLexiconSeedMapPath, seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';
import { readNextMainOutboxBatch, readMainOutboxEnvelope, type MainCloudEvent } from '../../../services/main/src/modules/outbox/relay.ts';
import type { OwnerCloudEvent } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { parseRetainedWorkDerivation } from '../../../services/main/src/modules/work/reconcile-derivation.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { RelationPageEntry } from '../../../services/main/src/modules/relation/traversal.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { assertCommandRace } from '../support/command-race.ts';

type Changed = { component: string; revision: string; replayed: boolean };
type Work = { work: string; mainVersion: string; mainRevision: string };
type Relation = { occurrence: string; revision: string; receipt: string; replayed: boolean; sourcePosition: { sequence: string } };
type Derivation = { derivation: string; receipt: string; replayed: boolean; sourcePosition: { sequence: string } };
type Page = { items: RelationPageEntry[]; next: string | null };

test('G-831: catalogue relations, open derivation kinds, both directions, privacy, replay and stale authority', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', 'relation-lexicon-qa', Bun.env.REZICS_QA_RUN_ID),
    'openid agent:create work:create work:edit work:read collection:edit semantic:read source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read');
  try {
    const queries: string[] = [], commands: { bytes: number; focuses: number }[] = [];
    f.env.fuseki = new Proxy(f.env.fuseki, { get(target, property) {
      if (property === 'query') return async (query: string) => { if (isForegroundOperation()) queries.push(query); return target.query(query); };
      if (property === 'commandWithReceipt') return async (command: CommandEnvelope) => {
        if (isForegroundOperation() && command.update.includes('LexiconWorkDerivation')) commands.push({ bytes: Buffer.byteLength(JSON.stringify(command)),
          focuses: command.validations.reduce((total, entry) => total + entry.focus.length, 0) });
        return target.commandWithReceipt(command);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!, bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    await f.grant('semantic:create:root', 'semantic.change');
    await f.grant('catalogue:verify:root', 'catalogue.verify');
    const namespace = `g831-${randomUUID()}`;
    // The QA shard shares its registry across files. Reuse canonical definitions
    // established by G-832, admitting this fixture actor separately to those IDs.
    const shared = await Promise.all(relationLexiconSeed.map(item => readDefinitionByKey(f.env, item.key, systemDisclosure)));
    const seed = shared.every(item => item !== null) ? shared.map((item, index) => ({
      key: relationLexiconSeed[index]!.key, component: item!.definition, revision: item!.revision,
    })) : await seedRelationLexicon({ post: async <T>(path: string, body: object, key: string) =>
      await f.json<T>(await f.call('POST', path, body, key), 201),
    authorizeDefinition: async receipt => { await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
      await f.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change'); } },
    f.actor, namespace, relationLexiconSeed);
    if (shared.every(item => item !== null)) {
      for (const receipt of seed) await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
    } else await unlink(relationLexiconSeedMapPath(namespace));
    const definitions = new Map(seed.map(item => [item.key, item]));
    const readGrants = new Map<string, string>();
    const work = async (title: string) => {
      const result = await f.json<Work>(await f.call('POST', '/v1/works', await f.catalogueBody({ profile: 'metadata-only-v1',
        language: 'ja', title, actingSubject: f.actor })), 201);
      readGrants.set(result.work, await f.grant(`work:read:${result.work}`, 'work.read'));
      return result;
    };
    const bunko = await work('Sword Art Online bunko'), web = await work('Sword Art Online web'), progressive = await work('Progressive');
    const aggoProposal = await f.propose('OL8310001W', [author('/authors/OL8310001A')], 'AGGO');
    f.setAuthorName('/authors/OL8310001A', 'Keiichi Sigsawa');
    const aggo = await f.adoptWork(aggoProposal);
    readGrants.set(aggo.work, await f.grant(`work:read:${aggo.work}`, 'work.read'));
    const original = await work('Index Original'), sequel = await work('New Testament');
    const railgunManga = await work('Railgun manga'), railgunAnime = await work('Railgun anime');
    const spiderWeb = await work('Spider web'), spiderBook = await work('Spider book');
    const hidden = await f.json<Work>(await f.call('POST', '/v1/works', await f.authoredBody({
      profile: 'metadata-only-v1', language: 'en', title: 'Hidden participant', actingSubject: f.actor })), 201);
    readGrants.set(hidden.work, await f.grant(`work:read:${hidden.work}`, 'work.read'));
    const query = `actingSubject=${encodeURIComponent(f.actor)}`;
    const page = async (resource: string, language = 'en', extra = '') => await f.json<Page>(await f.call('GET',
      `/v1/resources/${shortId(resource)}/relations?${query}&languages=${language}${extra}`), 200);
    const derive = (target: Work, source: Work, kind: string, key = randomUUID(), unresolved = false,
      extras: object = {}) => f.call('POST', `/v1/resources/${shortId(target.work)}/derivations`, {
      profile: 'work-derivation-v2', targetMainVersion: target.mainVersion, expectedTargetHead: target.mainRevision,
      sourceWork: source.work, sourceMainVersion: unresolved ? null : source.mainVersion,
      sourceMainRevision: unresolved ? null : source.mainRevision, kind, evidence: 'https://example.com/derivation',
      actingSubject: f.actor, ...extras }, key);
    expect((await derive(bunko, web, 'rewrite')).status).toBe(403);
    const bunkoEdit = await f.grant(`work:edit:${bunko.work}`, 'work.edit');
    await f.grant(`work:edit:${progressive.work}`, 'work.edit');
    await f.grant(`work:edit:${railgunAnime.work}`, 'work.edit');
    const replayKey = randomUUID();
    const rewrite = await f.json<Derivation>(await derive(bunko, web, 'rewrite', replayKey), 201);
    expect(await f.json<Derivation>(await derive(bunko, web, 'rewrite', replayKey), 200)).toMatchObject({ derivation: rewrite.derivation, replayed: true });
    expect((await derive(bunko, web, 'reboot', replayKey)).status).toBe(409);
    expect((await derive(progressive, bunko, 'reboot', randomUUID(), false, { expectedTargetHead: nativeId() })).status).toBe(409);
    await f.json(await derive(progressive, bunko, 'reboot'), 201);
    const adaptation = await f.json<Derivation>(await derive(railgunAnime, railgunManga, 'adaptation', randomUUID(), true), 201);
    const occurrence = (key: string, bindings: Record<string, string>, evidence = 'https://example.com/relation',
      idempotencyKey = randomUUID(), extras: object = {}) => f.call('POST', '/v1/relations/changes', {
      profile: 'relation-change-v1', expectedHead: null, definition: definitions.get(key)!.revision,
      participations: Object.entries(bindings).map(([role, ref]) => ({ role, participant: { kind: 'resource', ref } })),
      evidence, actingSubject: f.actor, ...extras }, idempotencyKey);
    const assertedOccurrence = async (key: string, bindings: Record<string, string>, subject: string, idempotencyKey = randomUUID()) => {
      const result = await f.json<Relation>(await occurrence(key, bindings, undefined, idempotencyKey), 201);
      const batch = await readNextMainOutboxBatch(f.env.fuseki, f.env.lineage.dataEpoch,
        String(BigInt(result.sourcePosition.sequence) - 1n));
      expect(batch?.sequence).toBe(result.sourcePosition.sequence);
      const envelope = await readMainOutboxEnvelope(f.env.fuseki, batch!, batch!.eventIds[0]!) as OwnerCloudEvent;
      expect(envelope.type).toBe('com.rezics.relation.changed.v1');
      expect(envelope.data.receipt).toMatchObject({ id: result.receipt, action: 'relation.change',
        scope: `work:edit:${subject}`, work: subject, component: result.occurrence, revision: result.revision });
      return result;
    };
    expect((await occurrence('spin-off', { source: bunko.work, 'spin-off': aggo.work })).status).toBe(403);
    const aggoEdit = await f.grant(`work:edit:${aggo.work}`, 'work.edit');
    await f.grant(`work:edit:${sequel.work}`, 'work.edit');
    await f.grant(`work:edit:${railgunManga.work}`, 'work.edit');
    await f.grant(`work:edit:${spiderBook.work}`, 'work.edit');
    const spinKey = randomUUID();
    const spin = await assertedOccurrence('spin-off', { source: bunko.work, 'spin-off': aggo.work }, aggo.work, spinKey);
    expect(await f.json<Relation>(await occurrence('spin-off', { source: bunko.work, 'spin-off': aggo.work }, undefined, spinKey), 201))
      .toMatchObject({ occurrence: spin.occurrence, replayed: true });
    const staleOccurrence = await occurrence('spin-off', { source: bunko.work, 'spin-off': aggo.work }, undefined, randomUUID(),
      { occurrence: spin.occurrence, expectedHead: nativeId() });
    expect(staleOccurrence.status).toBe(409);
    const updateCommands = ['one', 'two'].map((suffix) =>
      occurrence.bind(
        null,
        'spin-off',
        { source: bunko.work, 'spin-off': aggo.work },
        `https://example.com/${suffix}`,
        randomUUID(),
        { occurrence: spin.occurrence, expectedHead: spin.revision },
      ),
    );
    await assertCommandRace(await Promise.all(updateCommands.map((send) => send())), 200, (index) =>
      updateCommands[index]!(),
    );
    const moved = await occurrence('spin-off', { source: bunko.work, 'spin-off': bunko.work }, undefined, randomUUID(),
      { occurrence: spin.occurrence, expectedHead: spin.revision });
    expect(moved.status).toBe(422);
    await assertedOccurrence('sequel', { predecessor: original.work, sequel: sequel.work }, sequel.work);
    await assertedOccurrence('spin-off', { source: original.work, 'spin-off': railgunManga.work }, railgunManga.work);
    const person = async (name: string) => {
      const result = await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1',
        actingSubject: f.actor, expectedHead: null, state: { component: 'resource', types: ['https://schema.org/Person'],
          properties: [{ predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } }] } }), 201);
      await f.grant(`semantic:read:${result.component}`, 'semantic.read');
      return result.component;
    };
    await f.json(await f.call('POST', `/v1/works/${shortId(aggo.work)}/source-author-credits`,
      f.input(aggoProposal, aggo, 0, '/authors/OL8310001A')), 201);
    await assertedOccurrence('credit-concept-supervision', { work: aggo.work, contributor: await person('Reki Kawahara') }, aggo.work);
    const statuses = new ReaderLibraryStatusStore(f.pool);
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]); }
    finally { await accountPool.end(); }
    const readerApp = createMainApp(f.env.fuseki, { environment: f.env, catalogueIntake: f.catalogueIntake, account: f.account.verifier,
      access: f.access, agentProvisioning: new AgentProvisioning(f.accessPool, f.env),
      profiles: new ProfilesAccess(f.accessPool), libraryStatus: statuses,
      libraryRatings: new ReaderLibraryRatings(f.accessPool) });
    const readerCall = (method: string, path: string, body?: object) => readerApp.handle(new Request(`http://main.local${path}`,
      { method, headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const reader = await f.json<{ agent: string }>(await readerCall('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Spider reader' }), 201);
    for (const target of [spiderWeb.work, spiderBook.work]) {
      const scope = `work:read:${target}`;
      await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`, [randomUUID(), f.principalId, reader.agent]);
      await f.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$3,$4,'work.read',now() + interval '1 hour')`, [randomUUID(), f.actor, reader.agent, scope]);
    }
    const readerState = async (target: string) => {
      const result = await f.json<Record<string, unknown>>(await readerCall('GET',
        `/v1/works/${shortId(target)}/reader-state?actingSubject=${encodeURIComponent(reader.agent)}`), 200);
      const { sourcePosition: _position, ...state } = result;
      return state;
    };
    await statuses.write({ agent: reader.agent, work: spiderWeb.work, status: 'reading', expectedVersion: 0, idempotencyKey: randomUUID() });
    await statuses.write({ agent: reader.agent, work: spiderBook.work, status: 'want-to-read', expectedVersion: 0, idempotencyKey: randomUUID() });
    const before = await statuses.batch(reader.agent, [spiderWeb.work, spiderBook.work]);
    const statesBefore = [await readerState(spiderWeb.work), await readerState(spiderBook.work)];
    for (const kind of ['equivalent', 'partial', 'revised']) {
      await assertedOccurrence(`correspondence-${kind}`, { source: spiderWeb.work, [kind === 'revised' ? 'revision' : 'target']: spiderBook.work }, spiderBook.work);
    }
    expect(await statuses.batch(reader.agent, [spiderWeb.work, spiderBook.work])).toEqual(before);
    expect([await readerState(spiderWeb.work), await readerState(spiderBook.work)]).toEqual(statesBefore);
    expect((await page(spiderWeb.work)).items.filter(item => item.kind === 'occurrence')).toHaveLength(3);
    await f.json(await readerCall('PUT', `/v1/works/${shortId(spiderWeb.work)}/reader-status`,
      { actingSubject: reader.agent, status: 'read', expectedVersion: 1 }), 200);
    expect(await statuses.batch(reader.agent, [spiderWeb.work])).toMatchObject([{ status: 'read', version: 2 }]);
    expect(await statuses.batch(reader.agent, [spiderBook.work])).toEqual(before.filter(state => state.work === spiderBook.work));
    expect(await readerState(spiderWeb.work)).toMatchObject({ status: { status: 'read', version: 2 } });
    expect(await readerState(spiderBook.work)).toEqual(statesBefore[1]);
    for (const language of ['ja', 'zh-Hant', 'en']) {
      const outgoing = await page(bunko.work, language), incoming = await page(web.work, language);
      const row = outgoing.items.find(item => item.relation === rewrite.derivation)!;
      expect(row.evidence).toBe('https://example.com/derivation');
      expect(row.rendering?.viewingRole).toBe('rewrite');
      expect(row.rendering?.projections[0]?.language).toBe(language);
      expect(incoming.items.find(item => item.relation === rewrite.derivation)?.rendering?.viewingRole).toBe('source');
      expect(row.counterparts[0]).toMatchObject({ reference: web.work, status: 'available' });
    }
    expect((await page(railgunAnime.work)).items.find(item => item.relation === adaptation.derivation)).toMatchObject({ sourceVersionStatus: 'unresolved', sourceMainRevision: null });
    expect((await page(railgunManga.work)).items.some(item => item.relation === adaptation.derivation)).toBe(true);
    expect((await page(original.work)).items).toHaveLength(2);
    expect((await page(aggo.work)).items).toHaveLength(3);
    const duplicate = await f.json<Relation>(await occurrence('spin-off', { source: bunko.work, 'spin-off': aggo.work }), 201);
    expect(duplicate.occurrence).not.toBe(spin.occurrence);
    queries.length = 0;
    expect((await page(aggo.work)).items).toHaveLength(4);
    expect(queries.filter(query => query.includes('SELECT ?presentation ?head ?language'))).toHaveLength(3);
    expect(queries.length).toBeLessThan(64);
    const legacyTarget = await work('Legacy adaptation');
    await f.grant(`work:edit:${legacyTarget.work}`, 'work.edit');
    const legacy = await f.json<Derivation>(await derive(legacyTarget, web, 'adaptation'), 201);
    expect((await page(legacyTarget.work)).items[0]?.rendering?.meaning.definition).toBe(definitions.get('adaptation')!.component);
    expect((await page(web.work)).items.some(item => item.relation === legacy.derivation)).toBe(true);
    const sixth = await f.json<Changed>(await f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1',
      actingSubject: f.actor, expectedHead: null, state: { component: 'definition', kind: 'relation', notation: 'sixth-kind', workSubjectRole: 'new-kind',
        roles: ['source', 'new-kind'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) } }), 201);
    await f.grant(`semantic:read:${sixth.component}`, 'semantic.read');
    const sixthTarget = await work('Sixth derivation');
    await f.grant(`work:edit:${sixthTarget.work}`, 'work.edit');
    const sixthResult = await f.json<Derivation>(await derive(sixthTarget, web, 'sixth-kind'), 201);
    expect((await page(sixthTarget.work)).items[0]?.rendering?.meaning.revision).toBe(sixth.revision);
    expect((await page(sixthTarget.work)).items[0]?.rendering?.projections[0]?.fallback?.reason).toBe('missing-direction');
    const keyLookup = await f.json<Changed & { definition: string }>(await f.call('GET', `/v1/lexicon/definitions/rewrite?${query}`), 200);
    expect(keyLookup.definition).toBe(definitions.get('rewrite')!.component);
    const batch = await readNextMainOutboxBatch(f.env.fuseki, f.env.lineage.dataEpoch,
      String(BigInt(sixthResult.sourcePosition.sequence) - 1n));
    const envelope = await readMainOutboxEnvelope(f.env.fuseki, batch!, batch!.eventIds[0]!) as MainCloudEvent;
    expect(parseRetainedWorkDerivation(envelope.id, envelope, { consumer: 'g831', dataEpoch: f.env.lineage.dataEpoch, sequence: sixthResult.sourcePosition.sequence,
      batchCount: '0', batchDigest: '', eventCount: '0', eventDigest: '' }, sixthResult.sourcePosition.sequence).input.kind).toBe(sixth.revision);
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST', '/v1/collections',
      { collection, name: 'Sword Art Online franchise', disclosure: 'public', actingSubject: f.actor }), 201);
    await f.json(await f.call('POST', `/v1/collections/${shortId(collection)}/changes`, {
      expectedHead: created.revision, actingSubject: f.actor,
      operations: [{ op: 'insert', role: 'member', parent: created.structure, position: 'last', target: bunko.work,
        selection: { mode: 'follow-context' } }] }), 200);
    expect((await page(bunko.work)).items.find(item => item.relation === collection)?.counterparts[0])
      .toMatchObject({ reference: collection, status: 'available', type: 'collection', name: { value: 'Sword Art Online franchise' } });
    const first = await page(bunko.work, 'en', '&limit=1');
    expect(first.items).toHaveLength(1); expect(first.next).not.toBeNull();
    const second = await page(bunko.work, 'en', `&limit=1&after=${first.next}`);
    expect(second.items[0]?.relation).not.toBe(first.items[0]?.relation);
    await f.json(await occurrence('correspondence-partial', { source: hidden.work, target: bunko.work }), 201);
    const stalePage = await f.call('GET', `/v1/resources/${shortId(bunko.work)}/relations?${query}&limit=1&after=${first.next}`);
    expect(stalePage.status).toBe(409);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [readGrants.get(hidden.work)]);
    const hiddenPage = await page(bunko.work);
    expect(hiddenPage.next).toBeNull();
    expect((await page(bunko.work, 'en', `&limit=${hiddenPage.items.length}`)).next).toBeNull();
    expect(JSON.stringify(hiddenPage)).not.toContain(hidden.work);
    expect(JSON.stringify(hiddenPage)).not.toContain('Hidden participant');
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [aggoEdit]);
    expect((await occurrence('credit-illustrator', { work: aggo.work, contributor: web.work })).status).toBe(403);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [bunkoEdit]);
    expect(await f.json<Derivation>(await derive(bunko, web, 'rewrite', replayKey), 200)).toMatchObject({ replayed: true });
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect(commands.every(command => command.bytes < 24 * 1024 && command.focuses === 1)).toBe(true);
    const persisted = await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(sixthResult.derivation)} rv:derivationKind ?kind } }`);
    expect(persisted.results?.bindings[0]?.kind?.value).toBe(sixth.revision);
  } finally { await f.close(); }
}, 240_000);

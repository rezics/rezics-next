import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readExactWorkRevision } from '../../../services/main/src/modules/work/history.ts';
import { phraseWorkTypes } from '../../../services/main/src/modules/work/search-facets.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { startMediaStack } from './media-support.ts';
import { projectDiscoveryBatch } from '../../../services/main/src/modules/discovery/source.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';

const BOOK = 'https://schema.org/Book';
const SKILL = 'https://rezics.com/vocab/SkillPackage';

test('G398: Open Library adoption states Book; a guarded Work type revision updates reads and search', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const h = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `work-type-command-${randomUUID()}`));
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (h.env as typeof h.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const proposal = await h.propose(`OL${Math.floor(Math.random() * 900000000) + 100000000}W`, [], 'An adopted book');
    expect(proposal).toMatchObject({ semanticTypes: [BOOK], semanticTypeBasis: 'source-record-type' });
    const adopted = await h.adoptWork(proposal);
    expect(adopted).toMatchObject({ adoptedFields: ['title', 'semanticTypes'],
      semanticTypes: [BOOK], semanticTypeBasis: 'source-record-type' });
    const adoptedTypes = await h.nativeFuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(adopted.work)} a <${BOOK}> . } }`);
    expect(adoptedTypes.boolean).toBe(true);
    await h.grant(`work:edit:${adopted.work}`, 'work.edit');
    await h.grant(`work:read:${adopted.work}`, 'work.read');
    const adoptedRead = await h.call('GET', `/v1/works/${shortId(adopted.work)}?actingSubject=${encodeURIComponent(h.actor)}`);
    expect((await h.json<{ types: string[] }>(adoptedRead, 200)).types).toContain(BOOK);
    const composition = await h.call('POST', '/v1/compositions', {
      profile: 'book-composition', work: adopted.work, mainVersion: adopted.mainVersion,
      actingSubject: h.actor });
    if (composition.status !== 201) throw new Error(`composition: ${composition.status} ${await composition.text()}`);
    const structure = (await composition.json() as { structure: string }).structure;
    expect((await h.call('PUT', `/v1/works/${shortId(adopted.work)}/type`, {
      profile: 'work-type-v1', expectedHead: adopted.workRevision,
      types: [SKILL], actingSubject: h.actor })).status).toBe(409);
    expect((await h.call('GET', `/v1/compositions/${shortId(structure)}?actingSubject=${encodeURIComponent(h.actor)}`)).status)
      .toBe(200);
    const adoptedType = await h.json<{ revision: string }>(await h.call('PUT',
      `/v1/works/${shortId(adopted.work)}/type`, {
        profile: 'work-type-v1', expectedHead: adopted.workRevision,
        types: [BOOK, 'https://schema.org/DigitalDocument'], actingSubject: h.actor }), 200);
    const sourceSupport = await h.json<{ sourceProposal: string; adoptedAtRevision: string;
      currentHead: string; appliedRevisionIsHead: boolean }>(await h.call('GET',
        `/v1/works/${shortId(adopted.work)}/source-support`), 200);
    expect(sourceSupport).toMatchObject({ sourceProposal: proposal.proposal,
      adoptedAtRevision: adopted.workRevision, currentHead: adoptedType.revision,
      appliedRevisionIsHead: false });
    expect((await h.call('GET', `/v1/compositions/${shortId(structure)}?actingSubject=${encodeURIComponent(h.actor)}`)).status)
      .toBe(200);

    const generic = await h.json<{ work: string; mainVersion: string; workRevision: string }>(
      await h.call('POST', '/v1/works', await h.authoredBody({ profile: 'metadata-only-v1', title: 'Type revision', language: 'en',
        actingSubject: h.actor })), 201);
    const path = `/v1/works/${shortId(generic.work)}/type`;
    const body = { profile: 'work-type-v1', expectedHead: generic.workRevision,
      types: [SKILL], actingSubject: h.actor };
    const key = `type-${randomUUID()}`;
    expect((await h.call('PUT', path, body, key, h.account.noScope)).status).toBe(401);
    expect((await h.call('PUT', path, body, key)).status).toBe(403);
    await h.grant(`work:edit:${generic.work}`, 'work.edit');
    await h.grant(`work:read:${generic.work}`, 'work.read');
    const changed = await h.json<{ revision: string; predecessor: string; replayed: boolean;
      sourcePosition: { dataEpoch: string; sequence: string } }>(
      await h.call('PUT', path, body, key), 200);
    expect(changed).toMatchObject({ predecessor: generic.workRevision, replayed: false });
    expect(changed.revision).not.toBe(generic.workRevision);
    expect(await h.json(await h.call('PUT', path, body, key), 200)).toMatchObject({
      revision: changed.revision, replayed: true });
    expect((await h.call('PUT', path, { ...body, types: [BOOK] }, key)).status).toBe(409);
    expect((await h.call('PUT', path, body, `type-${randomUUID()}`)).status).toBe(409);
    const exact = await readExactWorkRevision(h.env, changed.revision,
      async owner => owner === generic.work);
    expect(exact).toMatchObject({ predecessor: generic.workRevision, semanticTypes: [SKILL],
      mainVersion: generic.mainVersion });
    const old = await readExactWorkRevision(h.env, generic.workRevision,
      async owner => owner === generic.work);
    expect(old.semanticTypes).toEqual([]);
    const read = await h.call('GET', `/v1/works/${shortId(generic.work)}?actingSubject=${encodeURIComponent(h.actor)}`);
    expect((await h.json<{ revision: string; types: string[] }>(read, 200)))
      .toMatchObject({ revision: changed.revision, types: [SKILL] });
    const control = await h.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?epoch ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
        <urn:rezics:dataset:product> rv:dataEpoch ?epoch ; rv:sequence ?sequence . } }`);
    const position = control.results!.bindings[0]!;
    const searchTypes = await phraseWorkTypes(h.env, [{ work: generic.work, language: 'en' }],
      { dataEpoch: position.epoch!.value, sequence: position.sequence!.value });
    expect(searchTypes.get(generic.work)).toEqual([SKILL]);
    const competing = await Promise.all([[BOOK], ['https://schema.org/DigitalDocument']]
      .map(types => h.call('PUT', path, { ...body, expectedHead: changed.revision, types },
        `type-${randomUUID()}`)));
    expect(competing.map(response => response.status).sort()).toEqual([200, 409]);
  } finally { await h.close(); }
}, 180_000);

test('G398: a public Work type change reaches discovery and phrase search at the new graph head', async () => {
  const stack = await startMediaStack('work-type-discovery');
  try {
    const actor = await stack.member('type-editor');
    const work = await stack.publicWork(actor.actor, ['en'], 'Public type revision');
    await actor.grant(`work:edit:${work.work}`, 'work.edit');
    const beforeResponse = await stack.main.handle(new Request(`http://main.local/v1/works/${shortId(work.work)}`));
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json() as { revision: string; types: string[] };
    expect(before.types).toEqual([]);
    const changedResponse = await actor.send('PUT', `/v1/works/${shortId(work.work)}/type`, {
      profile: 'work-type-v1', expectedHead: before.revision, types: [BOOK],
      actingSubject: actor.actor });
    expect(changedResponse.status).toBe(200);
    const changed = await changedResponse.json() as { revision: string;
      sourcePosition: { dataEpoch: string; sequence: string } };
    const deps = { environment: stack.env, access: stack.access } as MainWorkDependencies;
    const session = new WorkReadSession(deps, new Request('http://main.local/v1/works'),
      { scope: 'global' }, changed.sourcePosition);
    const discovery = await projectDiscoveryBatch(session,
      { scope: 'global', realm: null, context: null }, '', { works: [work.work], limit: 1 });
    expect(discovery.items).toMatchObject([{ work: work.work, revision: changed.revision,
      types: [BOOK] }]);
    expect((await phraseWorkTypes(stack.env, [{ work: work.work, language: 'en' }],
      changed.sourcePosition)).get(work.work)).toEqual([BOOK]);
  } finally { await stack.stop(); }
}, 120_000);

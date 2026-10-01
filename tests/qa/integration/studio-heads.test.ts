import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { StudioAccess } from '../../../services/main/src/modules/studio/access.ts';
import { STUDIO_CHAPTER_COST } from '../../../services/main/src/modules/studio/chapters.ts';
import { authorWorkGeneration } from '../../../services/main/src/modules/access/author-baseline.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { canonicalChapterWorks } from '../../../services/main/src/modules/structure/chapter-work.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import { studioRoutes } from '../../../services/main/src/routes/studio.ts';
import { contentRoutes } from '../../../services/main/src/routes/content.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

test('STUDIO draft heads and Work title language survive edits and stale retries', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `studio-heads-${randomUUID()}`));
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try { await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [f.account.a.id]); }
    finally { await accountPool.end(); }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    f.access.configureBaseline(f.env.fuseki);
    expect((await f.call('POST', '/v1/works', { profile: 'metadata-only-v1',
      title: 'Missing language', actingSubject: f.actor })).status).toBe(400);
    expect((await f.call('POST', '/v1/works', { profile: 'metadata-only-v1',
      title: 'Invalid language', language: 'not_a_tag', actingSubject: f.actor })).status).toBe(400);
    const missing = await f.call('POST', '/v1/works', { profile: 'metadata-only-v1',
      authoring: 'own-work', title: 'Unready author', language: 'en', actingSubject: f.actor });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: 'author_agent_unavailable' });
    const agent = { kind: 'person' as const, displayName: 'Studio Author' };
    const graphAgent = await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor,
      ...agent, digest: agentProvisionDigest(agent) });
    const created = await f.json<{ work: string; mainVersion: string; workRevision: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: '日本語の作品', language: 'ja',
      semanticTypes: ['https://schema.org/Book'],
      localizedTitle: { value: 'A Japanese work', language: 'en' },
      description: { value: '作品の説明', language: 'ja' }, actingSubject: f.actor,
    }), 201);
    const undetermined = await f.json<{ work: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work',
      title: 'Unknown original language', language: 'und',
      actingSubject: f.actor,
    }), 201);
    await f.grant(`work:read:${created.work}`, 'work.read');
    const studio = new Elysia().use(studioRoutes({ environment: f.env, catalogueIntake: f.catalogueIntake,
      account: f.account.verifier, access: f.access, studioAccess: new StudioAccess(f.accessPool, f.env.fuseki) }));
    const studioPath = `/v1/me/agents/${shortId(f.actor)}/works`;
    const studioCall = (token = f.account.tokenA) => studio.handle(new Request(`http://main.local${studioPath}`,
      { headers: { authorization: `Bearer ${token}` } }));
    expect((await studioCall()).status).toBe(403);
    const controlId = randomUUID();
    await f.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`, [controlId, f.principalId, f.actor]);
    await f.accessPool.query(`INSERT INTO access.agent_provision (id, principal_id, idempotency_key,
      request_digest, agent_id, agent_kind, display_name, principal_epoch, state,
      graph_data_epoch, graph_sequence, representation_id)
      VALUES ($1,$2,$3,$4,$5,'person',$6,0,'active',$7,$8,$9)`, [randomUUID(), f.principalId,
      randomUUID(), agentProvisionDigest(agent), f.actor, agent.displayName,
      graphAgent.dataEpoch, graphAgent.sequence, controlId]);
    expect((await studioCall(f.account.tokenB)).status).toBe(403);
    const listed = await f.json<{ items: Array<{ id: string; state: string; texts: unknown[] }> }>(
      await studioCall(), 200);
    expect(listed.items).toContainEqual(expect.objectContaining({ id: created.work,
      state: 'empty', texts: [] }));
    expect((await f.json<{ items: Array<{ id: string; title: { language: string } }> }>(
      await studioCall(), 200)).items).toContainEqual(expect.objectContaining({ id: undetermined.work,
      title: expect.objectContaining({ language: 'und' }) }));
    expect(await f.json<{ item: { id: string; relationship: string } }>(await studio.handle(new Request(
      `http://main.local/v1/me/agents/${shortId(f.actor)}/works/${shortId(created.work)}`,
      { headers: { authorization: `Bearer ${f.account.tokenA}` } })), 200))
      .toMatchObject({ item: { id: created.work, relationship: 'authored' } });
    const exact = await f.json<{ title: string; language: string }>(await f.call('GET',
      `/v1/revisions/${shortId(created.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(exact).toMatchObject({ title: '日本語の作品', language: 'ja',
      localizedTitle: { value: 'A Japanese work', language: 'en' },
      description: { value: '作品の説明', language: 'ja' } });

    await f.grant(`contribution:create:${created.work}`, 'contribution.create');
    const contribution = await f.json<{ contribution: string; draftRevision: string }>(await f.call('POST',
      '/v1/contributions', { profile: 'text-contribution-v1', work: created.work,
        language: 'ja', body: '最初の本文', actingSubject: f.actor }), 201);
    await f.grant(`contribution:read:${contribution.contribution}`, 'contribution.read');
    await f.grant(`contribution:edit:${contribution.contribution}`, 'contribution.edit');
    const headPath = `/v1/contributions/${shortId(contribution.contribution)}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await f.call('GET', headPath, undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const first = await f.json<{ work: string; language: string; author: string;
      draftHead: string; publicationHead: string | null }>(await f.call('GET', headPath), 200);
    expect(first).toMatchObject({ work: created.work, language: 'ja', author: f.actor,
      draftHead: contribution.draftRevision, publicationHead: null });

    const edited = await f.json<{ draftRevision: string }>(await f.call('POST', '/v1/contribution-edits', {
      profile: 'text-contribution-v1', contribution: contribution.contribution,
      expectedHead: contribution.draftRevision, body: '二番目の本文', actingSubject: f.actor,
    }), 200);
    expect(edited.draftRevision).not.toBe(first.draftHead);
    const stale = await f.call('POST', '/v1/contribution-edits', {
      profile: 'text-contribution-v1', contribution: contribution.contribution,
      expectedHead: contribution.draftRevision, body: '古い本文', actingSubject: f.actor,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_head', currentHead: edited.draftRevision });
    expect(await f.json<{ draftHead: string }>(await f.call('GET', headPath), 200))
      .toMatchObject({ draftHead: edited.draftRevision });

    const content = new ContentCore(f.pool);
    const contentApp = new Elysia().use(contentRoutes(f.env.fuseki, {
      environment: f.env, catalogueIntake: f.catalogueIntake, account: f.account.verifier, access: f.access,
      content: content, contentAuthoring: content,
    })).use(studioRoutes({ environment: f.env, catalogueIntake: f.catalogueIntake, account: f.account.verifier,
      access: f.access, contentAuthoring: content, studioAccess: new StudioAccess(f.accessPool, f.env.fuseki) }));
    const contentCall = (method: string, path: string, body?: object) => contentApp.handle(new Request(
      `http://main.local${path}`, { method, headers: { authorization: `Bearer ${f.account.tokenA}`,
        'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const variantsPath = `/v1/works/${shortId(created.work)}/content-variants?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await contentCall('GET', variantsPath)).status).toBe(200);
    expect(await f.json<{ items: unknown[] }>(await contentCall('GET', variantsPath), 200))
      .toMatchObject({ items: [] });
    await f.grant(`work:edit:${created.work}`, 'work.edit');
    await f.grant(`content:draft:${created.work}`, 'content.draft');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draftBody = '章の本文';
    const saved = await f.json<{ revisionId: string; byteDigest: string }>(await contentCall('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: created.work,
        variantId, language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: 'ltr',
        expectedHead: null, body: draftBody, actingSubject: f.actor }), 201);
    expect(saved.byteDigest).toBe(createHash('sha256').update(JSON.stringify({ body: draftBody })).digest('hex'));
    expect(await f.json<{ items: unknown[] }>(await contentCall('GET', variantsPath), 200))
      .toMatchObject({ items: [{ variantId, draftHead: saved.revisionId,
        publicationHead: null, eligibilityHead: null }] });
    const newer = await f.json<{ revisionId: string }>(await contentCall('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: created.work, variantId,
      language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: 'ltr',
      expectedHead: saved.revisionId, body: '改訂後の本文', actingSubject: f.actor,
    }), 201);
    const staleContent = await contentCall('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: created.work, variantId,
      language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: 'ltr',
      expectedHead: saved.revisionId, body: '古い改訂', actingSubject: f.actor,
    });
    expect(staleContent.status).toBe(409);
    expect(await staleContent.json()).toMatchObject({ code: 'stale_head', currentHead: newer.revisionId });

    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const composition = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'book-composition', work: created.work,
        mainVersion: created.mainVersion, actingSubject: f.actor }), 201);
    const chapterBody = { profile: 'book-chapter-create-v1', title: '第一章', language: 'ja',
      direction: 'ltr', parent: composition.structure, position: 'last',
      expectedCompositionHead: composition.revision, actingSubject: f.actor };
    const chapterKey = randomUUID();
    const chapterCall = (payload: object = chapterBody) => studio.handle(new Request(
      `http://main.local/v1/works/${shortId(created.work)}/chapters`, { method: 'POST',
        headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
          'idempotency-key': chapterKey }, body: JSON.stringify(payload) }));
    const chapter = await f.json<{ work: string; workRevision: string; occurrence: string; compositionRevision: string;
      variantId: string; replayed: boolean }>(await chapterCall(), 200);
    expect(chapter.replayed).toBe(false);
    const chapterClient = await f.accessPool.connect();
    try {
      expect((await chapterClient.query<{ action: string }>(`SELECT a.action FROM access.work_maintainer_set s
        JOIN access.admission a ON a.id = s.creation_admission WHERE s.work = $1`, [chapter.work])).rows[0]?.action)
        .toBe('work.edit');
      expect(await authorWorkGeneration(chapterClient, f.env.fuseki, f.principalId, f.actor, chapter.work)).toBe('0');
    } finally { chapterClient.release(); }
    expect(chapter.variantId).toMatch(/^urn:rezics:variant:/);
    const chapterReadPath = `/v1/me/agents/${shortId(f.actor)}/works/${shortId(created.work)}/chapters?language=ja`;
    const chapterRead = async () => f.json<{ page: { items: Array<{ occurrence: string }> };
      facts: Array<{ occurrence: string; writer: string | null; state: string | null;
        target: string | null; label: { value: string } | null }> }>(
      await contentCall('GET', chapterReadPath), 200);
    const firstChapters = await chapterRead();
    expect(firstChapters.page.items.map(item => item.occurrence)).toEqual([chapter.occurrence]);
    expect(firstChapters.facts).toMatchObject([{ occurrence: chapter.occurrence,
      writer: f.actor, state: 'empty', target: chapter.work, label: { value: '第一章' } }]);
    const mapping = await canonicalChapterWorks(new WorkReadSession(
      { environment: f.env } as MainWorkDependencies,
      new Request('http://main.local'), {},
      { dataEpoch: f.env.lineage.dataEpoch, sequence: chapter.compositionRevision }),
    [chapter.work, created.work]);
    expect(mapping.get(chapter.work)).toBe(created.work);
    expect(mapping.has(created.work)).toBe(false);
    expect((await f.json<typeof chapter>(await chapterCall(), 200))).toMatchObject({
      work: chapter.work, occurrence: chapter.occurrence,
      compositionRevision: chapter.compositionRevision, replayed: true });
    expect((await chapterCall({ ...chapterBody, title: '改題' })).status).toBe(409);
    expect((await chapterCall({ ...chapterBody, direction: 'rtl' })).status).toBe(409);
    const staleChapter = await studio.handle(new Request(
      `http://main.local/v1/works/${shortId(created.work)}/chapters`, { method: 'POST',
        headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, body: JSON.stringify(chapterBody) }));
    expect(staleChapter.status).toBe(409);
    const chapterResult = chapter as typeof chapter & { receipt: string;
      sourcePosition: { dataEpoch: string; sequence: string } };
    const eventIds = ['structure', 'chapter'].map(suffix =>
      `urn:rezics:event:${hash(`${chapterResult.receipt}\0${suffix}`)}`);
    const batch = { batchId: `urn:rezics:outbox:${hash(chapterResult.receipt)}`,
      dataEpoch: chapterResult.sourcePosition.dataEpoch,
      sequence: chapterResult.sourcePosition.sequence,
      routingEpoch: f.env.lineage.routingEpoch, eventIds };
    const commandEvent = await readMainOutboxEnvelope(f.env.fuseki, batch, eventIds[0]!);
    expect(commandEvent.data.receipt).toMatchObject({ chapterWork: chapter.work });
    const chapterEvent = await readMainOutboxEnvelope(f.env.fuseki, batch, eventIds[1]!);
    expect(chapterEvent.data.receipt).toMatchObject({ chapter: { work: chapter.work,
      compositionRevision: chapter.compositionRevision } });
    const chapterInventory = await f.json<{ items: Array<{ id: string }> }>(await studioCall(), 200);
    expect(chapterInventory.items.map(item => item.id)).toContain(created.work);
    expect(chapterInventory.items.map(item => item.id)).not.toContain(chapter.work);
    const exactChapterPath = `/v1/me/agents/${shortId(f.actor)}/works/${shortId(chapter.work)}`;
    expect(await f.json<{ item: { id: string; relationship: string; texts: unknown[]; submissions: unknown[] } }>(await studio.handle(
      new Request(`http://main.local${exactChapterPath}`, { headers: { authorization: `Bearer ${f.account.tokenA}` } })), 200))
      .toMatchObject({ item: { id: chapter.work, relationship: 'authored', texts: [], submissions: [] } });
    expect((await studio.handle(new Request(`http://main.local${exactChapterPath}`))).status).toBe(401);
    expect((await studio.handle(new Request(`http://main.local/v1/me/agents/${shortId(f.actor)}/works/${randomUUID()}`,
      { headers: { authorization: `Bearer ${f.account.tokenA}` } }))).status).toBe(404);
    const source = await f.propose(`OL${Math.floor(Math.random() * 900000 + 100000)}W`,
      undefined, 'Imported studio classic');
    const imported = await f.adoptWork(source);
    const curated = await f.json<{ work: string }>(await f.call('POST', '/v1/works', await f.catalogueBody({
      profile: 'metadata-only-v1', title: 'Curated studio Work', language: 'en', actingSubject: f.actor,
    })), 201);
    const authored = await f.json<{ items: Array<{ id: string }> }>(await studioCall(), 200);
    expect(authored.items.map(item => item.id)).not.toContain(imported.work);
    expect(authored.items.map(item => item.id)).not.toContain(curated.work);
    const imports = await f.json<{ items: Array<{ id: string; relationship: string }> }>(
      await studio.handle(new Request(`http://main.local${studioPath}?view=curated`,
        { headers: { authorization: `Bearer ${f.account.tokenA}` } })), 200);
    expect(imports.items).toContainEqual(expect.objectContaining({ id: imported.work,
      relationship: 'curated' }));
    expect(imports.items).toContainEqual(expect.objectContaining({ id: curated.work,
      relationship: 'curated' }));
    await f.grant(`work:read:${chapter.work}`, 'work.read');
    const chapterHead = await f.json<{ title: string; language: string }>(await f.call('GET',
      `/v1/revisions/${shortId(chapter.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(chapterHead).toMatchObject({ title: '第一章', language: 'ja' });
    const chapterDraft = await f.json<{ revisionId: string }>(await contentCall('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: chapter.work,
        variantId: chapter.variantId, language: { kind: 'tag', tag: 'ja', originalTag: 'ja' },
        direction: 'ltr', expectedHead: null, body: '第一章の本文', actingSubject: f.actor }), 201);
    const chapterVariants = `/v1/works/${shortId(chapter.work)}/content-variants?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json<{ items: unknown[] }>(await contentCall('GET', chapterVariants), 200))
      .toMatchObject({ items: [{ variantId: chapter.variantId, draftHead: chapterDraft.revisionId }] });
    expect((await chapterRead()).facts).toMatchObject([{ state: 'draft', target: chapter.work }]);
    const writer = async (name: string, principal: string, controlled: boolean) => {
      const agentId = `https://rezics.com/id/${randomUUID()}`;
      await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [agentId]);
      const profile = { kind: 'person' as const, displayName: name };
      const graph = await createAgentGraph(f.env, { id: randomUUID(), agent: agentId,
        ...profile, digest: agentProvisionDigest(profile) });
      for (const [scope, action] of [[`work:edit:${created.work}`, 'work.edit'],
        [`work:read:${created.work}`, 'work.read']] as const) {
        await f.accessPool.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,'infinity'::timestamptz)`, [randomUUID(), principal, agentId, action]);
        await f.accessPool.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,'infinity'::timestamptz)`, [randomUUID(), agentId, scope, action]);
      }
      if (controlled) {
        const control = randomUUID();
        await f.accessPool.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`, [control, principal, agentId]);
        await f.accessPool.query(`INSERT INTO access.agent_provision (id, principal_id, idempotency_key,
          request_digest, agent_id, agent_kind, display_name, principal_epoch, state,
          graph_data_epoch, graph_sequence, representation_id)
          VALUES ($1,$2,$3,$4,$5,'person',$6,0,'active',$7,$8,$9)`, [randomUUID(), principal,
          randomUUID(), agentProvisionDigest(profile), agentId, profile.displayName,
          graph.dataEpoch, graph.sequence, control]);
      }
      return agentId;
    };
    const pen = await writer('Studio pen name', f.principalId, true);
    const stranger = await writer('Another writer', f.otherPrincipal, false);
    const chapterAs = async (actingSubject: string, token: string, title: string, expectedCompositionHead: string) =>
      f.json<{ work: string; occurrence: string; compositionRevision: string }>(await studio.handle(new Request(
        `http://main.local/v1/works/${shortId(created.work)}/chapters`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            'idempotency-key': randomUUID() },
          body: JSON.stringify({ ...chapterBody, title, actingSubject, expectedCompositionHead }) })), 200);
    const penChapter = await chapterAs(pen, f.account.tokenA, '第二章', chapter.compositionRevision);
    const strangerChapter = await chapterAs(stranger, f.account.tokenB, 'Private third chapter',
      penChapter.compositionRevision);
    const chapterAccess = new StudioAccess(f.accessPool, f.env.fuseki);
    const principal = await f.account.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${f.account.tokenA}` } }), ['work:read']);
    expect((await chapterAccess.chapterWriters(principal, f.actor, [penChapter.work])).get(penChapter.work))
      .toEqual({ writer: pen, controlled: true });
    expect(await chapterAccess.canReadContentVariants(principal, pen, penChapter.work)).toBe(true);
    const disclosed = await chapterRead();
    expect(disclosed.facts).toMatchObject([
      { writer: f.actor, state: 'draft', target: chapter.work },
      { writer: pen, otherIdentity: true, state: 'empty', target: penChapter.work,
        label: { value: '第二章' } },
      { writer: null, state: null, target: null, label: null },
    ]);
    expect(disclosed.page.items[2]).toMatchObject({ occurrence: strangerChapter.occurrence });
    // Length measures the writer's own draft, in characters for Japanese; a volume lists its chapters one level at a time.
    expect(disclosed.facts[0]).toMatchObject({ length: { unit: 'characters', value: 6 } });
    const volume = await f.json<{ revision: string; occurrences: string[] }>(await f.call('POST',
      `/v1/compositions/${shortId(composition.structure)}/changes`, { profile: 'book-composition',
        expectedHead: strangerChapter.compositionRevision, actingSubject: f.actor, operations: [{ op: 'insert',
          parent: composition.structure, position: 'first', role: 'group', division: 'volume',
          label: { value: '第一巻', language: 'ja' } }] }), 200);
    await f.json(await f.call('POST', `/v1/compositions/${shortId(composition.structure)}/changes`, {
      profile: 'book-composition', expectedHead: volume.revision, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence: chapter.occurrence, parent: volume.occurrences[0], position: 'last' }] }), 200);
    const top = await chapterRead();
    expect(top.page.items[0]).toMatchObject({ occurrence: volume.occurrences[0], role: 'group',
      division: 'volume', number: 1, childCount: 1 });
    const inVolume = await f.json<{ page: { items: Array<{ occurrence: string; number: number | null }> };
      facts: Array<{ occurrence: string; length: unknown; state: string | null }> }>(await contentCall('GET',
      `${chapterReadPath}&parent=${encodeURIComponent(volume.occurrences[0]!)}`), 200);
    expect(inVolume.page.items).toMatchObject([{ occurrence: chapter.occurrence, number: 1 }]);
    expect(inVolume.facts).toMatchObject([{ occurrence: chapter.occurrence, state: 'draft',
      length: { unit: 'characters', value: 6 } }]);
    let statements = 0;
    const measuredFuseki = new Proxy(f.env.fuseki, { get(target, key) {
      if (key === 'query') return (...args: Parameters<typeof target.query>) => {
        statements += 1; return target.query(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const measured = new Elysia().use(studioRoutes({ environment: { ...f.env, fuseki: measuredFuseki },
      account: f.account.verifier, access: f.access, contentAuthoring: content,
      studioAccess: new StudioAccess(f.accessPool, f.env.fuseki) }));
    expect((await measured.handle(new Request(`http://main.local${chapterReadPath}`,
      { headers: { authorization: `Bearer ${f.account.tokenA}` } }))).status).toBe(200);
    expect(statements).toBeLessThanOrEqual(STUDIO_CHAPTER_COST.graphStatements);
  } finally { await f.close(); }
}, 20_000);

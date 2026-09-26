import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { activateMetadataWork, GRAPHS, ID, RV, iri, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { MAX_REVISION_DERIVATIONS } from '../../../services/main/src/modules/work/derivations.ts';
import { initializeRelayCheckpoint, readNextMainOutboxBatch, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';

const root = resolve(import.meta.dir, '../../..');

test('WORK04: admitted exact Work derivations retain kind, source and target revisions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `work-derivation-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const actor = ID + randomUUID();
  const principal = { issuer: 'https://qa-derivation.test', subject: randomUUID() };
  const principalId = randomUUID();
  const admission = (requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId, actingSubject: actor, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: `work04-create-${id}`, requestDigest,
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  try {
    const sharedTitle = `Shared title ${randomUUID()}`;
    const works = await Promise.all(['source', 'adaptation', 'recording', 'fork'].map((label, index) => {
      const title = index < 2 ? sharedTitle : `${label} ${randomUUID()}`;
      return activateMetadataWork(env, { title, admission: admission(metadataWorkRequestDigest(title)) });
    }));
    const [source, ...targets] = works;
    if (!source || targets.length !== 3) throw new Error('Work activation incomplete');
    expect(new Set(works.map(item => item.work)).size).toBe(4);
    expect(new Set(works.map(item => item.mainVersion)).size).toBe(4);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    const access = new AccessAdmissionRegistry(accessPool);
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access });
    const send = (body: object, key: string = randomUUID()) => app.handle(new Request(
      'http://main.local/v1/work-derivations', { method: 'POST', headers: {
        authorization: 'Bearer qa', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ profile: 'work-derivation-v1', ...body }) }));
    const read = (main: string, revision: string) => app.handle(new Request(
      `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/work-derivations`));
    expect(await read(targets[0]!.mainVersion, targets[0]!.mainRevision).then(response => response.json()))
      .toMatchObject({ complete: true, derivations: [] });
    const bodies = targets.map((target, index) => ({ targetWork: target.work,
      targetMainVersion: target.mainVersion, expectedTargetHead: target.mainRevision,
      sourceWork: source.work, sourceMainVersion: source.mainVersion,
      sourceMainRevision: source.mainRevision,
      kind: (['adaptation', 'new-recording', 'software-fork'] as const)[index]!,
      evidence: `https://creator.example/continuity/${index + 1}`, actingSubject: actor }));
    for (const target of targets) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
        [`derivation:link:${target.work}`]);
    }
    const denied = await send(bodies[0]!);
    expect(denied.status).toBe(403);
    for (const target of targets) {
      const scope = `derivation:link:${target.work}`;
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'work.derive', now() + interval '1 hour')`,
      [randomUUID(), principalId, actor]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'work.derive', now() + interval '1 hour')`,
      [randomUUID(), actor, scope]);
    }
    const badSource = await send({ ...bodies[0], sourceMainRevision: ID + randomUUID() });
    expect(badSource.status).toBe(404);
    const stale = await send({ ...bodies[0], expectedTargetHead: ID + randomUUID() });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_target_head');
    const receipts: Array<{ derivation: string; receipt: string;
      sourcePosition: { sequence: string }; kind: string }> = [];
    for (const body of bodies) {
      const key = `derive-${randomUUID()}`;
      const response = await send(body, key);
      expect(response.status).toBe(201);
      const result = await response.json() as {
        derivation: string; receipt: string; replayed: boolean;
        sourcePosition: { sequence: string }; kind: string;
      };
      receipts.push(result);
      expect(result).toMatchObject({ kind: body.kind, replayed: false });
      const replay = await send(body, key);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ derivation: result.derivation,
        receipt: result.receipt, replayed: true });
      const inventory = await read(body.targetMainVersion, body.expectedTargetHead);
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toMatchObject({ complete: true, derivations: [{
        derivation: result.derivation, targetWork: body.targetWork,
        targetMainRevision: body.expectedTargetHead, sourceWork: source.work,
        sourceMainRevision: source.mainRevision, kind: body.kind, evidence: body.evidence }] });
      const bound = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(result.derivation)} a rv:WorkDerivation ;
            rv:sourceMainRevision ${iri(source.mainRevision)} ;
            rv:targetMainRevision ${iri(body.expectedTargetHead)} .
        }
      }`);
      expect(bound.boolean).toBe(true);
      expect((await send({ ...body, evidence: 'https://creator.example/different' }, key)).status).toBe(409);
      expect((await send(body)).status).toBe(409);
    }
    expect((await read(targets[0]!.mainVersion, ID + randomUUID())).status).toBe(404);
    expect((await read(source.mainVersion, source.mainRevision)).status).toBe(200);
    const last = receipts[2]!;
    const batch = await readNextMainOutboxBatch(env.fuseki, env.lineage.dataEpoch,
      (BigInt(last.sourcePosition.sequence) - 1n).toString());
    expect(batch?.eventIds).toHaveLength(1);
    const consumer = `work04:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
    // The shared stack has earlier batches owned by other fixtures. Position
    // this consumer immediately before our new batch and verify its handoff.
    const preceding = (BigInt(last.sourcePosition.sequence) - 1n).toString();
    await relayPool.query('UPDATE relay.checkpoint SET sequence = $2 WHERE consumer = $1',
      [consumer, preceding]);
    expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence)
      .toBe(last.sourcePosition.sequence);
    const delivered = await relayPool.query<{ envelope: { type: string; data: {
      receipt: Record<string, unknown> } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE event_id = $1', [batch!.eventIds[0]]);
    expect(delivered.rows).toHaveLength(1);
    expect(delivered.rows[0]!.envelope).toMatchObject({ type: 'com.rezics.work.derived.v1',
      data: { receipt: { workDerivation: last.derivation, derivationKind: 'software-fork',
        sourceMainRevision: source.mainRevision, targetMainRevision: targets[2]!.mainRevision } } });
  } finally {
    await Promise.all([accessPool.end(), relayPool.end()]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('WORK04: multi-source and corrected continuity stay exact per retained revision', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `work-continuity-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const actor = ID + randomUUID();
  const principal = { issuer: 'https://qa-continuity.test', subject: randomUUID() };
  const principalId = randomUUID();
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId, actingSubject: actor, scope, action,
      idempotencyKey: `work04-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  const grant = async (scope: string, action: string) => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [scope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
  };
  try {
    const [novel, play, film, remake] = await Promise.all(['Novel', 'Play', 'Film', 'Remake']
      .map(label => {
        const title = `${label} ${randomUUID()}`;
        return activateMetadataWork(env, { title, admission: admission('work:create:root',
          'work.create', metadataWorkRequestDigest(title)) });
      }));
    if (!novel || !play || !film || !remake) throw new Error('Work activation incomplete');
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access: new AccessAdmissionRegistry(accessPool) });
    const post = (path: string, body: object, key: string = randomUUID()) => app.handle(new Request(
      `http://main.local${path}`, { method: 'POST', headers: { authorization: 'Bearer qa',
        'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
    const derive = (body: object, key?: string) =>
      post('/v1/work-derivations', { profile: 'work-derivation-v1', ...body }, key);
    type Relation = { derivation: string; sourceWork: string; sourceMainVersion: string;
      sourceMainRevision: string; kind: string; corrects: string | null;
      supersededBy: string | null; status: string };
    const inventory = async (main: string, revision: string) => {
      const response = await app.handle(new Request(`http://main.local/v1/main-versions/${
        main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/work-derivations`));
      expect(response.status).toBe(200);
      return (await response.json() as { complete: boolean; derivations: Relation[] });
    };

    // Advance the novel's Main Version so its first revision is retained history, not the head.
    const draftInput = { work: novel.work, language: 'en', body: 'Novel body', actingSubject: actor };
    const draft = await activateTextContribution(env, admission(`contribution:create:${novel.work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (!draft.contribution || !draft.draftRevision) throw new Error('novel draft was not retained');
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const published = await publishTextContribution(env, admission(
      `contribution:publish:${draft.contribution}`, 'contribution.publish',
      textPublicationDigest(publishInput)), publishInput);
    if (!published.publicationDecision) throw new Error('novel publication failed');
    await grant(`publication:select:${novel.mainVersion}`, 'publication.select');
    const selected = await post('/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: novel.mainVersion }, work: novel.work,
      contribution: draft.contribution, publicationDecision: published.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor });
    expect(selected.status).toBe(201);
    const novelHead = (await selected.json() as { mainRevision: string }).mainRevision;
    expect(novelHead).not.toBe(novel.mainRevision);

    for (const target of [film, remake]) await grant(`derivation:link:${target.work}`, 'work.derive');
    const fromNovel = { targetWork: film.work, targetMainVersion: film.mainVersion,
      expectedTargetHead: film.mainRevision, sourceWork: novel.work,
      sourceMainVersion: novel.mainVersion, sourceMainRevision: novel.mainRevision,
      kind: 'adaptation', evidence: 'https://studio.example/film/credits', actingSubject: actor };
    const fromPlay = { ...fromNovel, sourceWork: play.work, sourceMainVersion: play.mainVersion,
      sourceMainRevision: play.mainRevision, evidence: 'https://studio.example/film/play-credit' };
    const first = await derive(fromNovel);
    expect(first.status).toBe(201);
    const novelDeclaration = await first.json() as Relation;
    expect(novelDeclaration).toMatchObject({ sourceMainRevision: novel.mainRevision,
      corrects: null, supersededBy: null, status: 'effective' });
    const second = await derive(fromPlay);
    expect(second.status).toBe(201);
    const playDeclaration = await second.json() as Relation;
    expect(await inventory(film.mainVersion, film.mainRevision)).toEqual(expect.objectContaining({
      complete: true, derivations: [
        expect.objectContaining({ derivation: novelDeclaration.derivation, sourceWork: novel.work,
          sourceMainRevision: novel.mainRevision, status: 'effective' }),
        expect.objectContaining({ derivation: playDeclaration.derivation, sourceWork: play.work,
          sourceMainRevision: play.mainRevision, status: 'effective' })] }));
    const duplicate = await derive({ ...fromNovel, sourceMainRevision: novelHead });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: 'work_derivation_conflict' });

    // A correction names the effective declaration it replaces; the earlier one stays readable.
    const correction = { ...fromNovel, sourceMainRevision: novelHead, kind: 'new-recording',
      evidence: 'https://studio.example/film/corrected-credits', corrects: novelDeclaration.derivation };
    const correctionKey = `correct-${randomUUID()}`;
    const corrected = await derive(correction, correctionKey);
    expect(corrected.status).toBe(201);
    const correctedDeclaration = await corrected.json() as Relation;
    expect(correctedDeclaration).toMatchObject({ corrects: novelDeclaration.derivation,
      sourceMainRevision: novelHead, kind: 'new-recording', status: 'effective' });
    const replay = await derive(correction, correctionKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ derivation: correctedDeclaration.derivation,
      replayed: true });
    expect((await derive({ ...correction, kind: 'adaptation' }, correctionKey)).status).toBe(409);
    expect((await inventory(film.mainVersion, film.mainRevision)).derivations).toEqual([
      expect.objectContaining({ derivation: novelDeclaration.derivation, kind: 'adaptation',
        sourceMainRevision: novel.mainRevision, corrects: null,
        supersededBy: correctedDeclaration.derivation, status: 'superseded' }),
      expect.objectContaining({ derivation: playDeclaration.derivation, status: 'effective' }),
      expect.objectContaining({ derivation: correctedDeclaration.derivation,
        corrects: novelDeclaration.derivation, supersededBy: null, status: 'effective' })]);
    const staleCorrection = await derive({ ...correction, evidence: 'https://studio.example/late' });
    expect(staleCorrection.status).toBe(409);
    expect((await derive({ ...correction, corrects: ID + randomUUID() })).status).toBe(404);
    // A correction cannot move a declaration to another source; that is a new declaration.
    expect((await derive({ ...fromPlay, corrects: novelDeclaration.derivation,
      evidence: 'https://studio.example/wrong-source' })).status).toBe(404);
    const unchanged = await derive({ ...correction, corrects: correctedDeclaration.derivation });
    expect(unchanged.status).toBe(400);

    // Concurrent corrections of one effective declaration: exactly one supersedes it.
    const racing = await Promise.all(['a', 'b'].map(label => derive({ ...correction,
      corrects: correctedDeclaration.derivation, evidence: `https://studio.example/race/${label}` })));
    expect(racing.map(response => response.status).sort()).toEqual([201, 409]);
    const afterRace = (await inventory(film.mainVersion, film.mainRevision)).derivations;
    expect(afterRace.filter(item => item.sourceWork === novel.work && item.status === 'effective'))
      .toHaveLength(1);
    expect(afterRace.filter(item => item.corrects === correctedDeclaration.derivation)).toHaveLength(1);

    // Continuity through another derivation is a path of exact relations, never recursive embedding.
    const chained = await derive({ ...fromNovel, targetWork: remake.work,
      targetMainVersion: remake.mainVersion, expectedTargetHead: remake.mainRevision,
      sourceWork: film.work, sourceMainVersion: film.mainVersion,
      sourceMainRevision: film.mainRevision, kind: 'software-fork',
      evidence: 'https://studio.example/remake' });
    expect(chained.status).toBe(201);
    expect((await inventory(remake.mainVersion, remake.mainRevision)).derivations)
      .toEqual([expect.objectContaining({ sourceWork: film.work, status: 'effective' })]);
    expect((await inventory(novel.mainVersion, novelHead)).derivations).toEqual([]);

    // Cost: a declaration reads fixed keys; unrelated derivations add no Fuseki read calls.
    const observed = async (work: () => Promise<Response>) => {
      const budget = { signal: AbortSignal.timeout(15_000), callsLeft: 24, bytesLeft: 262_144 };
      const response = await fusekiReadBudget.run(budget, work);
      return { response, calls: 24 - budget.callsLeft, bytes: 262_144 - budget.bytesLeft };
    };
    const workFor = async (label: string) => {
      const title = `${label} ${randomUUID()}`;
      const created = await activateMetadataWork(env, { title, admission: admission(
        'work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
      await grant(`derivation:link:${created.work}`, 'work.derive');
      return created;
    };
    const declareFromPlay = (target: Awaited<ReturnType<typeof workFor>>) => derive({ ...fromPlay,
      targetWork: target.work, targetMainVersion: target.mainVersion,
      expectedTargetHead: target.mainRevision });
    const smallProbe = await workFor('Probe small');
    const small = await observed(() => declareFromPlay(smallProbe));
    expect(small.response.status).toBe(201);
    expect(small.calls).toBeGreaterThan(0);
    for (const unrelated of await Promise.all(Array.from({ length: 8 },
      (_, n) => workFor(`Unrelated ${n}`)))) {
      expect((await derive({ ...fromNovel, targetWork: unrelated.work,
        targetMainVersion: unrelated.mainVersion, expectedTargetHead: unrelated.mainRevision,
        sourceMainRevision: novelHead })).status).toBe(201);
    }
    const probe = await workFor('Probe grown');
    const grown = await observed(() => declareFromPlay(probe));
    expect(grown.response.status).toBe(201);
    expect(grown.calls).toBe(small.calls);
    expect(grown.bytes).toBeLessThanOrEqual(small.bytes + 1024);
    const readFilm = () => app.handle(new Request(`http://main.local/v1/main-versions/${
      film.mainVersion.slice(ID.length)}/revisions/${film.mainRevision.slice(ID.length)}/work-derivations`));
    const fewRead = await observed(readFilm);
    expect(fewRead.calls).toBe(2);

    // Each target revision retains a bounded declaration inventory.
    let effective = afterRace.find(item => item.sourceWork === novel.work && item.status === 'effective')!;
    for (let count = afterRace.length; count < MAX_REVISION_DERIVATIONS; count++) {
      const response = await derive({ ...correction, corrects: effective.derivation,
        evidence: `https://studio.example/revision/${count}` });
      expect(response.status).toBe(201);
      effective = await response.json() as Relation;
    }
    const bounded = await derive({ ...correction, corrects: effective.derivation,
      evidence: 'https://studio.example/over-bound' });
    expect(bounded.status).toBe(409);
    const full = await inventory(film.mainVersion, film.mainRevision);
    expect(full.derivations).toHaveLength(MAX_REVISION_DERIVATIONS);
    expect(full.derivations.filter(item => item.status === 'effective')
      .map(item => item.sourceWork).sort()).toEqual([novel.work, play.work].sort());
    // Reading k retained declarations is two fixed-key queries with O(k) result bytes.
    const fullRead = await observed(readFilm);
    expect(fullRead.calls).toBe(fewRead.calls);
    expect(fullRead.bytes).toBeLessThanOrEqual(
      Math.ceil(fewRead.bytes * MAX_REVISION_DERIVATIONS / afterRace.length) + 1024);

    // Corrections need the same current target-side authority as declarations.
    await accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2`, [actor, `derivation:link:${remake.work}`]);
    const chainedDeclaration = (await inventory(remake.mainVersion, remake.mainRevision)).derivations[0]!;
    const denied = await derive({ ...fromNovel, targetWork: remake.work,
      targetMainVersion: remake.mainVersion, expectedTargetHead: remake.mainRevision,
      sourceWork: film.work, sourceMainVersion: film.mainVersion,
      sourceMainRevision: film.mainRevision, kind: 'adaptation',
      evidence: 'https://studio.example/remake-denied', corrects: chainedDeclaration.derivation });
    expect(denied.status).toBe(403);
    expect((await inventory(remake.mainVersion, remake.mainRevision)).derivations)
      .toEqual([expect.objectContaining({ derivation: chainedDeclaration.derivation,
        status: 'effective' })]);
  } finally {
    await accessPool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

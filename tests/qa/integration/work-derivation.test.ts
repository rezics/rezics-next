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
import { MAX_REVISION_DERIVATIONS, type WorkDerivationInput }
  from '../../../services/main/src/modules/work/derivations.ts';
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

test('WORK04: an unresolved source version stays distinct and resolves later without rewriting history', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `work-unresolved-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const actor = ID + randomUUID();
  const principal = { issuer: 'https://qa-unresolved.test', subject: randomUUID() };
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
    const works = await Promise.all(['Novel', 'Play', 'Series', 'Anthology', 'Film', 'Spinoff'].map(label => {
      const title = `${label} ${randomUUID()}`;
      return activateMetadataWork(env, { title, admission: admission('work:create:root',
        'work.create', metadataWorkRequestDigest(title)) });
    }));
    const [novel, play, series, anthology, film, spinoff] = works;
    if (!novel || !play || !series || !anthology || !film || !spinoff) throw new Error('Work activation incomplete');
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    const access = new AccessAdmissionRegistry(accessPool);
    const account = { verify: async () => principal };
    const app = createMainApp(env.fuseki, { environment: env, account, access });
    type Relation = { derivation: string; sourceWork: string; sourceMainVersion: string | null;
      sourceMainRevision: string | null; sourceVersionStatus: string; kind: string;
      evidence: string; corrects: string | null; supersededBy: string | null; status: string };
    type Declared = { status: number; body: Relation & { code?: string; receipt: string;
      replayed: boolean; sourcePosition: { sequence: string } } };
    // Exercise the public POST contract, including nullable source identities.
    const declare = async (input: WorkDerivationInput, key: string = randomUUID()): Promise<Declared> => {
      const response = await app.handle(new Request('http://main.local/v1/work-derivations', {
        method: 'POST', headers: { authorization: 'Bearer qa',
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'work-derivation-v1', ...input }),
      }));
      return { status: response.status, body: await response.json() as Declared['body'] };
    };
    const inventory = async (main: string, revision: string) => {
      const response = await app.handle(new Request(`http://main.local/v1/main-versions/${
        main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/work-derivations`));
      expect(response.status).toBe(200);
      return (await response.json() as { profile: string; mainVersion: string; revision: string;
        complete: boolean; derivations: Relation[] });
    };
    const unresolved: WorkDerivationInput = { targetWork: film.work, targetMainVersion: film.mainVersion,
      expectedTargetHead: film.mainRevision, sourceWork: novel.work,
      sourceMainVersion: novel.mainVersion, sourceMainRevision: null, kind: 'adaptation',
      evidence: 'https://studio.example/film/based-on-the-novel', actingSubject: actor };

    // Denied before the target-side grant; nothing is recorded.
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`derivation:link:${film.work}`]);
    expect((await declare(unresolved)).status).toBe(403);
    expect((await inventory(film.mainVersion, film.mainRevision)).derivations).toEqual([]);
    for (const target of [film, spinoff]) await grant(`derivation:link:${target.work}`, 'work.derive');

    // An unresolved source still names an existing source Work and its own Main Version.
    expect((await declare({ ...unresolved, sourceMainVersion: ID + randomUUID() })).status).toBe(404);
    expect((await declare({ ...unresolved, sourceMainVersion: play.mainVersion })).status).toBe(404);
    const stale = await declare({ ...unresolved, expectedTargetHead: ID + randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_target_head');

    const key = `unresolved-${randomUUID()}`;
    const created = await declare(unresolved, key);
    expect(created.status).toBe(201);
    const declaration = created.body;
    expect(declaration).toMatchObject({ sourceWork: novel.work, sourceMainVersion: novel.mainVersion,
      sourceMainRevision: null, sourceVersionStatus: 'unresolved', corrects: null,
      supersededBy: null, status: 'effective', replayed: false });
    const replay = await declare(unresolved, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ derivation: declaration.derivation,
      receipt: declaration.receipt, replayed: true });
    // The same key naming an exact revision is a different request.
    expect((await declare({ ...unresolved, sourceMainRevision: novel.mainRevision }, key)).status)
      .toBe(409);
    // One effective declaration per source Main Version, whether exact or unresolved.
    for (const duplicate of [unresolved, { ...unresolved, sourceMainRevision: novel.mainRevision }]) {
      const conflict = await declare(duplicate);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('work_derivation_conflict');
    }
    // An exact and an unresolved source on one revision stay distinct in the complete inventory.
    const exact = await declare({ ...unresolved, sourceWork: play.work,
      sourceMainVersion: play.mainVersion, sourceMainRevision: play.mainRevision,
      evidence: 'https://studio.example/film/play-credit' });
    expect(exact.status).toBe(201);
    expect(await inventory(film.mainVersion, film.mainRevision)).toEqual({ profile: 'work-derivations-v1',
      mainVersion: film.mainVersion, revision: film.mainRevision, complete: true, derivations: [
        expect.objectContaining({ derivation: declaration.derivation, sourceMainRevision: null,
          sourceVersionStatus: 'unresolved', status: 'effective' }),
        expect.objectContaining({ derivation: exact.body.derivation,
          sourceMainRevision: play.mainRevision, sourceVersionStatus: 'exact', status: 'effective' })] });
    const originalTriples = `${iri(declaration.derivation)} a rv:UnresolvedWorkDerivation ;
          rv:targetMainRevision ${iri(film.mainRevision)} ; rv:sourceWork ${iri(novel.work)} ;
          rv:sourceMainVersion ${iri(novel.mainVersion)} ; rv:sourceVersionStatus rv:Unresolved ;
          rv:derivationKind rv:Adaptation ; rv:evidence ${JSON.stringify(unresolved.evidence)} ;
          rv:modelRevision <https://rezics.com/definition/work-derivation-unresolved-v1> .`;
    const graphHistory = () => env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${originalTriples}
        FILTER NOT EXISTS { ${iri(declaration.derivation)} rv:sourceMainRevision ?any }
        FILTER NOT EXISTS { ${iri(declaration.derivation)} a rv:WorkDerivation }
        FILTER NOT EXISTS { ${iri(declaration.derivation)} rv:corrects ?prior }
      }
    }`).then(result => result.boolean);
    expect(await graphHistory()).toBe(true);
    // Repeating the unresolved declaration as its own correction changes nothing.
    expect((await declare({ ...unresolved, corrects: declaration.derivation })).status).toBe(400);

    // Resolution is an exact declaration correcting the unresolved one; history is retained.
    const resolution = { ...unresolved, sourceMainRevision: novel.mainRevision,
      evidence: 'https://studio.example/film/first-edition', corrects: declaration.derivation };
    const resolveKey = `resolve-${randomUUID()}`;
    const resolved = await declare(resolution, resolveKey);
    expect(resolved.status).toBe(201);
    expect(resolved.body).toMatchObject({ corrects: declaration.derivation,
      sourceMainRevision: novel.mainRevision, sourceVersionStatus: 'exact', status: 'effective' });
    expect((await declare(resolution, resolveKey)).body).toMatchObject({
      derivation: resolved.body.derivation, replayed: true });
    expect((await inventory(film.mainVersion, film.mainRevision)).derivations).toEqual([
      expect.objectContaining({ derivation: declaration.derivation, sourceMainRevision: null,
        sourceVersionStatus: 'unresolved', kind: 'adaptation', evidence: unresolved.evidence,
        corrects: null, supersededBy: resolved.body.derivation, status: 'superseded' }),
      expect.objectContaining({ derivation: exact.body.derivation, status: 'effective' }),
      expect.objectContaining({ derivation: resolved.body.derivation, corrects: declaration.derivation,
        sourceVersionStatus: 'exact', supersededBy: null, status: 'effective' })]);
    expect(await graphHistory()).toBe(true);
    // A late second resolution of the superseded declaration is stale.
    const late = await declare({ ...resolution, evidence: 'https://studio.example/film/late' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('work_derivation_conflict');

    // Concurrent resolutions of one unresolved declaration: exactly one supersedes it.
    const fromSeries = { ...unresolved, sourceWork: series.work,
      sourceMainVersion: series.mainVersion, evidence: 'https://studio.example/film/series' };
    const pending = await declare(fromSeries);
    expect(pending.status).toBe(201);
    const racing = await Promise.all(['a', 'b'].map(label => declare({ ...fromSeries,
      sourceMainRevision: series.mainRevision, corrects: pending.body.derivation,
      evidence: `https://studio.example/film/series/${label}` })));
    expect(racing.map(item => item.status).sort()).toEqual([201, 409]);
    const afterRace = (await inventory(film.mainVersion, film.mainRevision)).derivations;
    expect(afterRace.filter(item => item.corrects === pending.body.derivation)).toHaveLength(1);
    expect(afterRace.filter(item => item.sourceWork === series.work && item.status === 'effective'))
      .toEqual([expect.objectContaining({ sourceVersionStatus: 'exact' })]);

    // A source Work may be known before either its Main Version or revision is known.
    const workOnly = { ...unresolved, sourceWork: spinoff.work, sourceMainVersion: null,
      evidence: 'https://studio.example/film/spinoff-work' };
    expect((await declare({ ...workOnly, sourceWork: ID + randomUUID() })).status).toBe(404);
    expect((await declare({ ...workOnly, sourceMainRevision: spinoff.mainRevision })).status).toBe(400);
    const workOnlyKey = `work-only-${randomUUID()}`;
    const workOnlyCreated = await declare(workOnly, workOnlyKey);
    expect(workOnlyCreated.status).toBe(201);
    expect(workOnlyCreated.body).toMatchObject({ sourceWork: spinoff.work,
      sourceMainVersion: null, sourceMainRevision: null, sourceVersionStatus: 'unresolved' });
    expect((await declare(workOnly, workOnlyKey)).body).toMatchObject({
      derivation: workOnlyCreated.body.derivation, replayed: true });
    expect((await declare({ ...workOnly, sourceMainVersion: spinoff.mainVersion })).status).toBe(409);
    const resolvedWorkOnly = await declare({ ...workOnly, sourceMainVersion: spinoff.mainVersion,
      sourceMainRevision: spinoff.mainRevision, corrects: workOnlyCreated.body.derivation,
      evidence: 'https://studio.example/film/spinoff-edition' });
    expect(resolvedWorkOnly.status).toBe(201);
    expect((await inventory(film.mainVersion, film.mainRevision)).derivations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ derivation: workOnlyCreated.body.derivation,
          sourceMainVersion: null, sourceMainRevision: null, status: 'superseded',
          supersededBy: resolvedWorkOnly.body.derivation }),
        expect.objectContaining({ derivation: resolvedWorkOnly.body.derivation,
          sourceMainVersion: spinoff.mainVersion, sourceMainRevision: spinoff.mainRevision,
          corrects: workOnlyCreated.body.derivation, status: 'effective' }),
      ]));
    expect((await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(workOnlyCreated.body.derivation)} a rv:UnresolvedWorkDerivation ;
        rv:sourceWork ${iri(spinoff.work)} ; rv:sourceVersionStatus rv:Unresolved .
      FILTER NOT EXISTS { ${iri(workOnlyCreated.body.derivation)} rv:sourceMainVersion ?main }
      FILTER NOT EXISTS { ${iri(workOnlyCreated.body.derivation)} rv:sourceMainRevision ?revision }
    } }`)).boolean).toBe(true);

    // The typed relay envelope keeps the source-version certainty and the resolution link.
    const consumer = `work04-unresolved:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
    const relay = async (sequence: string) => {
      await relayPool.query('UPDATE relay.checkpoint SET sequence = $2 WHERE consumer = $1',
        [consumer, (BigInt(sequence) - 1n).toString()]);
      expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence).toBe(sequence);
      const batch = await readNextMainOutboxBatch(env.fuseki, env.lineage.dataEpoch,
        (BigInt(sequence) - 1n).toString());
      const delivered = await relayPool.query<{ envelope: { type: string; data: {
        receipt: Record<string, unknown> } } }>(
        'SELECT envelope FROM relay.delivered_event WHERE event_id = $1', [batch!.eventIds[0]]);
      expect(delivered.rows).toHaveLength(1);
      return delivered.rows[0]!.envelope;
    };
    expect(await relay(declaration.sourcePosition.sequence)).toMatchObject({
      type: 'com.rezics.work.derived.v1', data: { receipt: { workDerivation: declaration.derivation,
        sourceMainVersion: novel.mainVersion, sourceMainRevision: null,
        sourceVersionStatus: 'unresolved', corrects: null, derivationKind: 'adaptation' } } });
    expect(await relay(resolved.body.sourcePosition.sequence)).toMatchObject({
      data: { receipt: { workDerivation: resolved.body.derivation,
        sourceMainRevision: novel.mainRevision, sourceVersionStatus: 'exact',
        corrects: declaration.derivation } } });
    expect(await relay(workOnlyCreated.body.sourcePosition.sequence)).toMatchObject({
      data: { receipt: { workDerivation: workOnlyCreated.body.derivation,
        sourceWork: spinoff.work, sourceMainVersion: null, sourceMainRevision: null,
        sourceVersionStatus: 'unresolved' } } });
    expect(await relay(resolvedWorkOnly.body.sourcePosition.sequence)).toMatchObject({
      data: { receipt: { workDerivation: resolvedWorkOnly.body.derivation,
        sourceMainVersion: spinoff.mainVersion, sourceMainRevision: spinoff.mainRevision,
        corrects: workOnlyCreated.body.derivation } } });

    // Cost: an unresolved declaration makes no more calls than an exact one, and
    // unrelated unresolved declarations add no Fuseki read calls or result growth.
    const observed = async (work: () => Promise<unknown>) => {
      const budget = { signal: AbortSignal.timeout(15_000), callsLeft: 24, bytesLeft: 262_144 };
      const result = await fusekiReadBudget.run(budget, work);
      return { result, calls: 24 - budget.callsLeft, bytes: 262_144 - budget.bytesLeft };
    };
    const workFor = async (label: string) => {
      const title = `${label} ${randomUUID()}`;
      const created = await activateMetadataWork(env, { title, admission: admission(
        'work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
      await grant(`derivation:link:${created.work}`, 'work.derive');
      return created;
    };
    const onto = (target: Awaited<ReturnType<typeof workFor>>, input: WorkDerivationInput) =>
      declare({ ...input, targetWork: target.work, targetMainVersion: target.mainVersion,
        expectedTargetHead: target.mainRevision });
    const exactTarget = await workFor('Exact probe');
    const exactProbe = await observed(() => onto(exactTarget,
      { ...unresolved, sourceMainRevision: novel.mainRevision }));
    expect((exactProbe.result as Declared).status).toBe(201);
    const smallProbe = await workFor('Unresolved probe');
    const small = await observed(() => onto(smallProbe, unresolved));
    expect((small.result as Declared).status).toBe(201);
    expect(small.calls).toBeGreaterThan(0);
    expect(small.calls).toBeLessThanOrEqual(exactProbe.calls);
    const workOnlyProbe = await workFor('Work-only probe');
    const workOnlyCost = await observed(() => onto(workOnlyProbe, { ...unresolved,
      sourceWork: spinoff.work, sourceMainVersion: null }));
    expect((workOnlyCost.result as Declared).status).toBe(201);
    expect(workOnlyCost.calls).toBeLessThanOrEqual(exactProbe.calls);
    expect(workOnlyCost.bytes).toBeLessThanOrEqual(small.bytes + 1024);
    for (const unrelated of await Promise.all(Array.from({ length: 8 },
      (_, n) => workFor(`Unrelated ${n}`)))) {
      expect((await onto(unrelated, unresolved)).status).toBe(201);
    }
    const grownProbe = await workFor('Unresolved grown');
    const grown = await observed(() => onto(grownProbe, unresolved));
    expect((grown.result as Declared).status).toBe(201);
    expect(grown.calls).toBe(small.calls);
    expect(grown.bytes).toBeLessThanOrEqual(small.bytes + 1024);
    const readSmall = await observed(() => inventory(smallProbe.mainVersion, smallProbe.mainRevision));
    const readFilm = await observed(() => inventory(film.mainVersion, film.mainRevision));
    expect(readSmall.calls).toBe(2);
    expect(readFilm.calls).toBe(2);

    // A later target revision inherits nothing; the old revision stays unresolved history.
    const spinoffKey = `spinoff-${randomUUID()}`;
    const onSpinoff = { ...unresolved, targetWork: spinoff.work, targetMainVersion: spinoff.mainVersion,
      expectedTargetHead: spinoff.mainRevision, kind: 'software-fork' as const,
      evidence: 'https://studio.example/spinoff' };
    const spun = await declare(onSpinoff, spinoffKey);
    expect(spun.status).toBe(201);
    const draftInput = { work: spinoff.work, language: 'en', body: 'Spinoff body', actingSubject: actor };
    const draft = await activateTextContribution(env, admission(`contribution:create:${spinoff.work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (!draft.contribution || !draft.draftRevision) throw new Error('spinoff draft was not retained');
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const published = await publishTextContribution(env, admission(
      `contribution:publish:${draft.contribution}`, 'contribution.publish',
      textPublicationDigest(publishInput)), publishInput);
    if (!published.publicationDecision) throw new Error('spinoff publication failed');
    await grant(`publication:select:${spinoff.mainVersion}`, 'publication.select');
    const selected = await app.handle(new Request('http://main.local/v1/publication-selections', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify({ profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: spinoff.mainVersion }, work: spinoff.work,
        contribution: draft.contribution, publicationDecision: published.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor }) }));
    expect(selected.status).toBe(201);
    const spinoffHead = (await selected.json() as { mainRevision: string }).mainRevision;
    expect(spinoffHead).not.toBe(spinoff.mainRevision);
    expect((await inventory(spinoff.mainVersion, spinoffHead)).derivations).toEqual([]);
    const staleResolution = await declare({ ...onSpinoff, sourceMainRevision: novel.mainRevision,
      corrects: spun.body.derivation });
    expect(staleResolution.status).toBe(409);
    expect(staleResolution.body.code).toBe('stale_target_head');
    expect((await declare(onSpinoff, spinoffKey)).body).toMatchObject({
      derivation: spun.body.derivation, replayed: true });
    expect((await inventory(spinoff.mainVersion, spinoff.mainRevision)).derivations).toEqual([
      expect.objectContaining({ derivation: spun.body.derivation, sourceMainRevision: null,
        sourceVersionStatus: 'unresolved', status: 'effective' })]);

    // Resolution needs the same current target-side authority; a denied one leaves it unresolved.
    const fromAnthology = { ...unresolved, sourceWork: anthology.work,
      sourceMainVersion: anthology.mainVersion, evidence: 'https://studio.example/film/anthology' };
    const open = await declare(fromAnthology);
    expect(open.status).toBe(201);
    const beforeDenial = (await inventory(film.mainVersion, film.mainRevision)).derivations;
    await accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2`, [actor, `derivation:link:${film.work}`]);
    const deniedResolution = await declare({ ...fromAnthology,
      sourceMainRevision: anthology.mainRevision, corrects: open.body.derivation });
    expect(deniedResolution.status).toBe(403);
    expect((await inventory(film.mainVersion, film.mainRevision)).derivations).toEqual(beforeDenial);
    expect(beforeDenial.find(item => item.derivation === open.body.derivation)).toMatchObject({
      sourceVersionStatus: 'unresolved', status: 'effective', supersededBy: null });
  } finally {
    await Promise.all([accessPool.end(), relayPool.end()]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { DATASET, GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { ownerOutboxEventHandler } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { readWorkStructurePublicationReceipt, workStructurePublicationDigest,
  type WorkStructurePublicationInput } from '../../../services/main/src/modules/work/structured-publication.ts';
import { strongRevokeWorkPrincipal } from '../../../services/main/src/modules/work/strong-revoke.ts';
import { publicWork } from '../../../services/main/src/modules/work/public-patterns.ts';
import { foregroundCounted } from '../integration/support/query-cost-meter.ts';

test('WORK10: publication settlement, withdrawal replay and restore holds keep one terminal public state', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structured-work-publication-recovery-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (fixture.env as typeof fixture.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  let restoreHeld = false;
  try {
    const work = await fixture.json<{ work: string; mainVersion: string }>(await fixture.call(
      'POST', '/v1/works', await fixture.authoredBody({ profile: 'metadata-only-v1', language: 'en',
        title: 'Structured publication recovery', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: fixture.actor })), 201);
    for (const [scope, action] of [
      [`work:edit:${work.work}`, 'work.edit'], [`work:edit:${work.work}`, 'recipe.edit'],
      [`work:read:${work.work}`, 'work.read'], [`work:publish:${work.work}`, 'work.publish'],
      [`work:publish:${work.work}`, 'work.withdraw-publication'],
    ]) {
      await grantFixtureAuthority(fixture.accessPool, { scope: scope!, requireDispatch: true,
        representations: [{ principalId: fixture.principalId, actor: fixture.actor,
          action: action!, lifetime: '8 hours' }],
        grant: { actor: fixture.actor, action: action!, lifetime: '8 hours' } });
    }
    const structure = await fixture.json<{ structure: string; revision: string }>(await fixture.call(
      'POST', '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: fixture.actor }, `recovery-structure-${randomUUID()}`), 201);
    const head = await fixture.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } } LIMIT 2`);
    const workHead = head.results?.bindings?.[0]?.head?.value;
    if (!workHead || head.results?.bindings?.length !== 1) throw new Error('Work head is ambiguous');

    const publishKey = `recovery-publish-${randomUUID()}`;
    const publishBody = { profile: 'work-structure-publication-v1', operation: 'publish',
      work: work.work, actingSubject: fixture.actor, expectedWorkHead: workHead,
      expectedMainVersion: work.mainVersion, structure: structure.structure,
      expectedStructureHead: structure.revision, expectedPublicationHead: null,
      disclosure: 'public', rightsBasis: 'original-contribution' };
    const publicationTrace: string[] = [];
    let loseNativeAcknowledgement = true;
    const originalFuseki = fixture.env.fuseki;
    fixture.env.fuseki = new Proxy(originalFuseki, {
      get(target, property) {
        if (property === 'query') return async (sparql: string, maxResponseBytes?: number,
          phase?: 'occurrence-discovery') => {
          try { return await target.query(sparql, maxResponseBytes, phase); }
          catch (error) {
            if (foregroundCounted()) {
              publicationTrace.push(`query failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            throw error;
          }
        };
        if (property === 'commandHealth') return async () => {
          try { return await target.commandHealth(); }
          catch (error) {
            publicationTrace.push(`command health failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        };
        if (property === 'commandWithReceipt') return async (envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
          if (envelope.update.includes('WorkStructurePublicationEvent')) {
            try {
              const result = await target.commandWithReceipt(envelope);
              if (loseNativeAcknowledgement && result.status === 'committed') {
                loseNativeAcknowledgement = false;
                publicationTrace.push('native publication command committed; its acknowledgement was lost');
                throw new Error('simulated lost native publication acknowledgement');
              }
              publicationTrace.push(`native publication command: ${JSON.stringify(result)}`);
              return result;
            } catch (error) {
              publicationTrace.push(`native publication command failed: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
          }
          return target.commandWithReceipt(envelope);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const claim = fixture.access.claim.bind(fixture.access);
    fixture.access.claim = async (...args) => {
      publicationTrace.push('Access claim started');
      try {
        const admission = await claim(...args);
        publicationTrace.push(`Access claim completed: ${admission.state}, dispatch=${admission.dispatchEligible}`);
        return admission;
      } catch (error) {
        publicationTrace.push(`Access claim failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    };
    const publicationFence = fixture.governance.withPublicationFence.bind(fixture.governance);
    fixture.governance.withPublicationFence = async function<T>(resources: readonly string[],
      dispatch: (allowed: boolean) => Promise<T>): Promise<T> {
      publicationTrace.push(`governance fence started: ${resources.join(',')}`);
      try {
        return await publicationFence(resources, async allowed => {
          publicationTrace.push(`governance fence dispatch: ${allowed}`);
          try { return await dispatch(allowed); }
          catch (error) {
            publicationTrace.push(`publication dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        });
      } catch (error) {
        publicationTrace.push(`governance fence failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    };
    const recordGraphOutcome = fixture.access.recordGraphOutcome.bind(fixture.access);
    let loseAccessAcknowledgement = true;
    let accessSealAttempts = 0;
    fixture.access.recordGraphOutcome = async (admissionId, receipt) => {
      accessSealAttempts++;
      if (loseAccessAcknowledgement && receipt.action === 'work.publish') {
        loseAccessAcknowledgement = false;
        throw new Error('simulated Access outcome acknowledgement loss');
      }
      return recordGraphOutcome(admissionId, receipt);
    };
    const interrupted = await fixture.call('POST', '/v1/work-publications', publishBody, publishKey);
    expect(interrupted.status).toBe(202);
    const uncertain = await fixture.accessPool.query<{ id: string; state: string;
      graph_receipt: string | null; graph_outcome: string | null }>(
    `SELECT id, state, graph_receipt, graph_outcome FROM access.admission
      WHERE principal_id = $1 AND idempotency_key = $2`, [fixture.principalId, publishKey]);
    expect(uncertain.rows).toHaveLength(1);
    expect(uncertain.rows[0]).toMatchObject({ state: 'claimed', graph_receipt: null, graph_outcome: null });
    const graphReceipt = await readWorkStructurePublicationReceipt(fixture.env, uncertain.rows[0]!.id, 'work.publish');
    if (!graphReceipt) {
      throw new Error(`publication receipt missing after interrupted settlement; Access seals=${accessSealAttempts}; ${publicationTrace.join(' | ')}`);
    }
    expect(graphReceipt).toMatchObject({ outcome: 'succeeded', work: work.work,
      structure: structure.structure, structureRevision: structure.revision });

    fixture.access.recordGraphOutcome = recordGraphOutcome;
    const settled = await fixture.json<{ replayed: boolean; publicationDecision: string }>(
      await fixture.call('POST', '/v1/work-publications', publishBody, publishKey), 200);
    expect(settled.replayed).toBe(true);
    const sealed = await fixture.accessPool.query<{ state: string; graph_receipt: string;
      graph_outcome: string }>(`SELECT state, graph_receipt, graph_outcome FROM access.admission WHERE id = $1`,
    [uncertain.rows[0]!.id]);
    expect(sealed.rows[0]).toMatchObject({ state: 'sealed', graph_receipt: graphReceipt!.receipt,
      graph_outcome: 'succeeded' });

    const liveRecipe = await fixture.call('GET', `/v1/recipes/works/${shortId(work.work)}`,
      undefined, randomUUID(), null);
    expect(liveRecipe.status).toBe(200);
    await fixture.nativeFuseki.update(`PREFIX rv: <${RV}>
      INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
    restoreHeld = true;
    const heldRead = await fixture.call('GET', `/v1/recipes/works/${shortId(work.work)}`,
      undefined, randomUUID(), null);
    expect(heldRead.status).toBe(503);
    expect(await heldRead.text()).not.toContain(structure.structure);
    await fixture.nativeFuseki.update(`PREFIX rv: <${RV}>
      DELETE DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
    restoreHeld = false;

    const withdrawKey = `recovery-withdraw-${randomUUID()}`;
    const withdrawBody = { profile: 'work-structure-publication-v1', operation: 'withdraw',
      work: work.work, actingSubject: fixture.actor, expectedPublicationHead: settled.publicationDecision };
    const withdrawn = await fixture.json<{ publicationDecision: string; replayed: boolean }>(
      await fixture.call('POST', '/v1/work-publications', withdrawBody, withdrawKey), 201);
    const repeatedWithdrawal = await fixture.json<{ publicationDecision: string; replayed: boolean }>(
      await fixture.call('POST', '/v1/work-publications', withdrawBody, withdrawKey), 200);
    expect(repeatedWithdrawal).toMatchObject({ publicationDecision: withdrawn.publicationDecision, replayed: true });

    const events = await fixture.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?batch ?sequence ?event ?kind ?receipt ?action ?decision ?predecessor WHERE {
        GRAPH ${iri(GRAPHS.outbox)} {
          ?batch rv:dataEpoch ${JSON.stringify(fixture.env.lineage.dataEpoch)} ; rv:sequence ?sequence ;
            rv:eventCount 1 ; rv:event ?event .
          ?event a ?kind ; rv:action ?action ; rv:receipt ?receipt ; rv:work ${iri(work.work)} .
          OPTIONAL { ?event rv:publicationDecision ?decision }
          OPTIONAL { ?event rv:predecessor ?predecessor }
        }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:outcome rv:Succeeded }
        VALUES ?kind { rv:WorkStructurePublicationEvent rv:WorkStructureWithdrawalEvent }
      } ORDER BY xsd:integer(?sequence) LIMIT 4`);
    const eventRows = events.results?.bindings ?? [];
    expect(eventRows).toHaveLength(2);
    for (const row of eventRows) {
      const kind = row.kind?.value;
      const eventId = row.event?.value;
      const receipt = row.receipt?.value;
      const batchId = row.batch?.value;
      const action = row.action?.value;
      const decision = row.decision?.value;
      const predecessor = row.predecessor?.value;
      const sequence = row.sequence?.value;
      if (!kind || !eventId || !receipt || !batchId || !action || !decision || !sequence) {
        throw new Error('Structured publication outbox row is incomplete');
      }
      const handler = await ownerOutboxEventHandler(kind);
      if (!handler) throw new Error('Structured publication outbox handler is missing');
      const read = () => handler.read({ fuseki: fixture.env.fuseki,
        batch: { batchId, dataEpoch: fixture.env.lineage.dataEpoch, sequence,
          routingEpoch: fixture.env.lineage.routingEpoch, eventIds: [eventId] },
        eventId, ordinal: 0, value: name => ({ receipt, action,
          eventWork: work.work, eventPublicationDecision: decision,
          ...(predecessor ? { eventPredecessor: predecessor } : {}) }[name]),
      });
      const firstReplay = await read();
      const duplicateReplay = await read();
      expect(duplicateReplay).toEqual(firstReplay);
      expect(firstReplay.data.receipt.outcome).toBe('succeeded');
    }

    const noCandidate = await fixture.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(noCandidate.results?.bindings ?? []).toHaveLength(0);

    const replayedAfterWithdrawal = await fixture.json<{ replayed: boolean; publicationDecision: string }>(
      await fixture.call('POST', '/v1/work-publications', publishBody, publishKey), 200);
    expect(replayedAfterWithdrawal).toMatchObject({ replayed: true,
      publicationDecision: settled.publicationDecision });
    const stillWithdrawn = await fixture.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(stillWithdrawn.results?.bindings ?? []).toHaveLength(0);
    const absent = await fixture.call('GET', `/v1/recipes/works/${shortId(work.work)}`,
      undefined, randomUUID(), null);
    const missing = await fixture.call('GET',
      '/v1/recipes/works/00000000-0000-4000-8000-000000000099', undefined, randomUUID(), null);
    const missingOutcome = [missing.status, await missing.text()];
    expect([absent.status, await absent.text()]).toEqual(missingOutcome);

    const principal = await fixture.account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${fixture.account.tokenA}` },
    }), ['work:edit']);
    const pendingInput: WorkStructurePublicationInput = { ...publishBody,
      expectedPublicationHead: withdrawn.publicationDecision };
    const pendingDigest = workStructurePublicationDigest(pendingInput);
    const pendingKey = `revoked-publish-${randomUUID()}`;
    const pending = await fixture.access.register({ principal, actingSubject: fixture.actor,
      baselineRelatedWork: work.work, scope: `work:publish:${work.work}`, action: 'work.publish',
      idempotencyKey: pendingKey, requestDigest: pendingDigest });
    await fixture.access.claim(pending.id, pendingDigest, principal);
    const epoch = (await fixture.accessPool.query<{ enforcement_epoch: string }>(
      'SELECT enforcement_epoch FROM access.principal WHERE id = $1', [fixture.principalId]))
      .rows[0]?.enforcement_epoch;
    if (!epoch) throw new Error('Publication maintainer principal has no enforcement epoch');
    const revoked = await strongRevokeWorkPrincipal(fixture.env, fixture.access, fixture.principalId, epoch);
    expect(revoked).toMatchObject({ status: 'complete', pending: 0, principalId: fixture.principalId });
    expect(await readWorkStructurePublicationReceipt(fixture.env, pending.id, 'work.publish'))
      .toMatchObject({ outcome: 'cancelled', work: work.work, attestedBy: fixture.actor });
    const settledAdmission = await fixture.accessPool.query<{ state: string; graph_outcome: string }>(
      'SELECT state, graph_outcome FROM access.admission WHERE id = $1', [pending.id]);
    expect(settledAdmission.rows).toEqual([{ state: 'sealed', graph_outcome: 'cancelled' }]);
    const revokedCandidate = await fixture.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?main WHERE { ${publicWork(iri(work.work), '?main')} } LIMIT 2`);
    expect(revokedCandidate.results?.bindings ?? []).toHaveLength(0);
    const revokedRead = await fixture.call('GET', `/v1/recipes/works/${shortId(work.work)}`,
      undefined, randomUUID(), null);
    expect([revokedRead.status, await revokedRead.text()]).toEqual(missingOutcome);
  } finally {
    if (restoreHeld) {
      try { await fixture.nativeFuseki.update(`PREFIX rv: <${RV}>
        DELETE DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`); }
      catch { /* retain the original failure */ }
    }
    await fixture.close();
  }
}, 240_000);

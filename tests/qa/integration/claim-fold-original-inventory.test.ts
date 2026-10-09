import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import {
  changeSemanticComponent,
  semanticChangeDigest,
  type DefinitionState,
} from '../../../services/main/src/modules/semantic/change.ts';
import {
  DATE_PUBLISHED_DEFINITION_NOTATION,
  DATE_PUBLISHED_PREDICATE,
  QUALIFICATION_DEFINITION_NOTATION,
} from '../../../services/main/src/modules/statement/qualification.ts';
import { StatementSeek } from '../../../services/main/src/modules/statement/seek.ts';
import {
  ClaimStatementFoldUnavailable,
  convertEligibleClaimsTurn,
  receiveClaimFoldOriginalInventoryTurn,
  type ClaimFoldMaintenanceTransport,
} from '../../../services/main/src/modules/verification/claim-fold.ts';
import {
  ADMISSIONS,
  recordAssessment,
} from '../../../services/main/src/modules/verification/graph.ts';
import {
  assessAdmittedClaim,
  assessmentDigest,
  createAdmittedClaim,
  type AssessClaimInput,
} from '../../../services/main/src/modules/verification/operations.ts';
import {
  VerificationStale,
  VerificationStore,
} from '../../../services/main/src/modules/verification/store.ts';
import {
  HUMAN_REVIEW_METHOD,
  SUMMARY_POLICY,
} from '../../../services/main/src/modules/verification/analysis.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { accessWithBaseline } from '../fixtures/access-baseline.ts';

const root = resolve(import.meta.dir, '../../..');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('real creators, evidence and assessments feed one original native inventory capture that stays unresolved and closed to recapture', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  const fusekiUrl = Bun.env.FUSEKI_URL;
  if (!runId || !fusekiUrl || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH)
    throw new Error('Use the isolated QA integration tier');
  const maintenance = Bun.env.FUSEKI_MAINTENANCE_TOKEN!;
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content'], 'owner');
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  const directory = join(root, '.temp', `claim-fold-original-inventory-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    await migrateContent(contentPool);
    account = await ratingAccount(
      { ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>,
      'openid claim:create claim:assess',
    );
    const fuseki = new FusekiClient(fusekiUrl, maintenance, Bun.env.FUSEKI_COMMAND_TOKEN!);
    const env = {
      fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: directory,
    };
    const access = accessWithBaseline(accessPool, fuseki);
    const store = new VerificationStore(contentPool);
    const principalId = randomUUID();
    const actor = agent();
    await accessPool.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, account.issuer, account.a.id],
    );
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [
      actor,
    ]);
    for (const [scope, action] of [
      ['verification:claim:global', 'verification.claim-create'],
      ['verification:assess:global', 'verification.claim-assess'],
    ] as const) {
      await accessPool.query(
        'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await accessPool.query(
        `INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), principalId, actor, action],
      );
      await accessPool.query(
        `INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), actor, scope, action],
      );
    }
    const deps = { env, account: account.verifier, access, store };
    const request = () =>
      new Request('http://main.local', { headers: { authorization: `Bearer ${account!.tokenA}` } });

    // Production creators: Account-verified, Access-registered and acknowledged C/R creation.
    const plain = await createAdmittedClaim(deps, request(), {
      referent: 'urn:original-inventory:referent',
      interpretationContext: 'urn:original-inventory:context',
      propositionPredicate: 'urn:original-inventory:predicate',
      value: { kind: 'literal', lexical: 'A retained exact claim', datatype: 'string' },
      valuePrecision: 'exact',
      valueQualifiers: [],
      validFrom: null,
      validUntil: null,
      editionScope: null,
      actingSubject: actor,
      idempotencyKey: `plain-${randomUUID()}`,
    });
    const eligible = await createAdmittedClaim(deps, request(), {
      referent: 'urn:retained:original-work',
      interpretationContext: 'urn:retained:publication-scope',
      propositionPredicate: DATE_PUBLISHED_PREDICATE,
      value: { kind: 'literal', lexical: '0001-01-01', datatype: 'date' },
      valuePrecision: 'approximate',
      valueQualifiers: ['disputed-attribution', 'inferred'],
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      editionScope: 'https://publisher.example/first-edition',
      actingSubject: actor,
      idempotencyKey: `eligible-${randomUUID()}`,
    });
    const claim = plain.claim.claim,
      claimRevision = plain.claim.revision;
    const evidence = await store.recordEvidence(principalId, `evidence-${randomUUID()}`, claim, {
      claimRevision,
      expectedHead: null,
      items: [],
    });
    const intent = (key: string): AssessClaimInput & { idempotencyKey: string } => ({
      claimRevision,
      evidenceSetRevision: evidence.evidence.revision,
      sourceAssessments: [],
      method: 'human-review',
      judgment: 'supported',
      evaluationContext: 'urn:original-inventory:context',
      adoptedRevision: null,
      scorePerMillion: null,
      calibration: null,
      limitations: 'An explicit human judgment over the exact retained evidence manifest.',
      expectedSummary: null,
      resolvesChallenges: [],
      actingSubject: actor,
      idempotencyKey: key,
    });
    // Production assessment path: Content intent is staged before native dispatch and Access acknowledgement.
    const produced = await assessAdmittedClaim(
      deps,
      request(),
      claim,
      intent(`assessed-${randomUUID()}`),
    );
    // A native assessment acknowledged in Access without any retained Content intent stays unresolved.
    const { idempotencyKey: lostKey, ...lostIntent } = intent(`lost-${randomUUID()}`);
    const lostDigest = assessmentDigest(claim, lostIntent);
    const lost = await access.register({
      principal: await account.verifier.verify(request(), ['claim:assess']),
      actingSubject: actor,
      scope: ADMISSIONS['claim-assess'].scope,
      action: ADMISSIONS['claim-assess'].action,
      idempotencyKey: lostKey,
      requestDigest: lostDigest,
    });
    const lostReceipt = await recordAssessment(
      env,
      await access.claim(lost.id, lostDigest),
      lostDigest,
      {
        claim,
        claimRevision,
        representation: 'claim',
        evidenceSetRevision: evidence.evidence.revision,
        sourceAssessments: [],
        method: HUMAN_REVIEW_METHOD,
        methodRevision: HUMAN_REVIEW_METHOD,
        policyRevision: SUMMARY_POLICY,
        evaluationContext: lostIntent.evaluationContext,
        coverage: 'complete',
        support: 'supported',
        dependence: 'established',
        independentOrigins: 0,
        scorePerMillion: null,
        calibration: null,
        evaluationReference: null,
        limitations: lostIntent.limitations,
        assessorKind: 'human',
        actingSubject: actor,
      },
    );
    await access.recordGraphOutcome(lost.id, lostReceipt);
    expect(
      (
        await contentPool.query(
          'SELECT 1 FROM verification.assessment_producer WHERE admission_id=$1',
          [lost.id],
        )
      ).rowCount,
    ).toBe(0);

    // Reviewed meaning bindings and the exact seek baseline the later conversion needs.
    const semantic = async (state: DefinitionState) => {
      const admission: RegisteredAdmission = {
        id: randomUUID(),
        principalId: randomUUID(),
        actingSubject: agent(),
        scope: 'semantic:create:root',
        action: 'semantic.change',
        requestDigest: semanticChangeDigest(undefined, null, state),
        idempotencyKey: randomUUID(),
        authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        state: 'claimed',
        dispatchEligible: true,
        replayed: false,
      };
      return (await changeSemanticComponent(env, { expectedHead: null, state, admission }))
        .revision;
    };
    const relationDefinition = await semantic({
      component: 'definition',
      kind: 'property',
      roles: [],
      lifecycle: 'active',
      successor: null,
      notation: DATE_PUBLISHED_DEFINITION_NOTATION,
    });
    const qualificationDefinition = await semantic({
      component: 'definition',
      kind: 'interpretation',
      roles: [],
      lifecycle: 'active',
      successor: null,
      notation: QUALIFICATION_DEFINITION_NOTATION,
    });
    const seek = new StatementSeek(accessPool, env);
    while (await seek.projectOnce()) {
      /* the owning projector establishes the exact pre-conversion seek cut */
    }
    expect((await seek.coverage())?.complete).toBe(true);

    // Close Content1704 first: a late producer must now be refused, never staged beside the capture.
    const gate = (
      await contentPool.query<{ generation: string }>(
        'SELECT generation::text FROM verification.assessment_producer_gate WHERE singleton',
      )
    ).rows[0]!.generation;
    const permit = await store.closeAssessmentProducerGate(
      `original-inventory-${randomUUID()}`,
      gate,
    );
    await expect(
      store.stageAssessmentProducer({
        admission: randomUUID(),
        requestDigest: lostDigest,
        principal: principalId,
        actingSubject: actor,
        scope: ADMISSIONS['claim-assess'].scope,
        authorityEpoch: '0',
        idempotencyKey: `late-${randomUUID()}`,
        claim,
        claimRevision,
        intent: lostIntent,
      }),
    ).rejects.toBeInstanceOf(VerificationStale);

    // The fixed maintenance wire; the command capability must not reach it.
    const post = (capability: string, body: object, signal?: AbortSignal) =>
      fetch(new URL('command', fusekiUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    expect((await post(Bun.env.FUSEKI_COMMAND_TOKEN!, { claimFoldInventory: {} })).status).toBe(
      403,
    );
    const wire = { requests: 0, loseNext: true };
    const transport: ClaimFoldMaintenanceTransport = {
      async claimFoldInventory(body, signal) {
        wire.requests++;
        const response = await post(maintenance, { claimFoldInventory: body }, signal);
        expect(response.status).toBe(200);
        const page = await response.json();
        if (wire.loseNext && body.page === 0) {
          wire.loseNext = false;
          throw new Error('Lost durable native inventory acknowledgement');
        }
        return page;
      },
      async claimFoldMembers(body, signal) {
        const response = await post(maintenance, { claimFoldMembers: body }, signal);
        expect(response.status).toBe(200);
        return response.json();
      },
    };
    const job = 'original-inventory-job';
    const map = { relationDefinition, qualificationDefinition };
    const input = (
      progress?: Parameters<typeof receiveClaimFoldOriginalInventoryTurn>[2]['progress'],
    ) => ({
      ...map,
      job,
      transport,
      contentPool,
      store,
      permit,
      maintenanceCapability: maintenance,
      progress,
    });
    const first = await receiveClaimFoldOriginalInventoryTurn(env, accessPool, input());
    expect(first).toMatchObject({
      status: 'partial',
      reason: 'retry-exact-request',
      complete: false,
      release: 'denied',
    });
    if (first.status !== 'partial') throw new Error('Expected the lost acknowledgement to retry');
    expect(first.progress.inventory).toMatchObject({ page: 0, total: 0, sealed: false });
    expect(first.progress.audit.done).toBe(true);
    const captured = await receiveClaimFoldOriginalInventoryTurn(
      env,
      accessPool,
      input(first.progress),
    );
    if (captured.status !== 'captured')
      throw new Error(`Expected capture, received ${captured.status}`);
    expect(captured).toMatchObject({ complete: false, release: 'denied' });
    expect(wire.requests).toBe(2);
    const fence = (
      await accessPool.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text FROM access.recovery_fence WHERE id',
      )
    ).rows[0]!;
    expect(fence.open).toBe(false);
    expect(captured.original).toMatchObject({
      total: 2,
      directory: { count: 2 },
      access: { generation: fence.generation },
      content: { generation: permit.generation, restoreEpoch: permit.restoreEpoch },
      linkage: {
        creatorAcknowledgement: 'unresolved',
        evidenceToRevision: 'unresolved',
        retainedBodyCustody: 'unresolved',
        seekReconciliation: 'unresolved',
      },
    });
    // Both production assessments are classified: only the one with retained Content intent binds.
    expect(captured.original.assessmentHistory).toMatchObject({
      entries: 2,
      counts: { bound: 1, 'unresolved:content-missing': 1 },
    });
    expect(produced.assessment?.assessment).toBeTruthy();
    const members = await post(maintenance, {
      claimFoldMembers: {
        job: captured.original.job,
        sourceCut: captured.original.sourceCut,
        seal: captured.original.seal,
        progress: '',
        deadline: Date.now() + 60_000,
      },
    });
    const directory2 = (await members.json()) as {
      rows: { claim: string }[];
      directoryEOF: boolean;
    };
    expect(directory2.directoryEOF).toBe(true);
    expect(directory2.rows.map((row) => row.claim).sort()).toEqual(
      [claim, eligible.claim.claim].sort(),
    );

    // Caller-supplied progress is authenticated before any cached flag, count or cut is trusted.
    const requestsBefore = wire.requests;
    const { mac: _mac, ...unsigned } = captured.progress;
    for (const forged of [
      unsigned,
      { ...captured.progress, members: { ...captured.progress.members, count: 99 } },
      {
        ...captured.progress,
        inventory: { ...captured.progress.inventory, sourceCut: 'a'.repeat(64) },
      },
      { ...captured.progress, mac: 'b'.repeat(64) },
    ]) {
      await expect(
        receiveClaimFoldOriginalInventoryTurn(
          env,
          accessPool,
          input(forged as typeof captured.progress),
        ),
      ).rejects.toBeInstanceOf(ClaimStatementFoldUnavailable);
    }
    expect(wire.requests).toBe(requestsBefore);
    // The genuine signed bytes verify again after a serialization round trip with the same capability.
    const restarted = await receiveClaimFoldOriginalInventoryTurn(
      env,
      accessPool,
      input(JSON.parse(JSON.stringify(captured.progress))),
    );
    expect(restarted.status === 'captured' && restarted.original).toEqual(captured.original);

    // Conversion is gated by the sealed original inventory; afterwards no newer CURRENT can replace it.
    const converted = await convertEligibleClaimsTurn(env, accessPool, {
      ...map,
      job,
      claims: [{ claim: eligible.claim.claim, claimRevision: eligible.claim.revision }],
    });
    expect(converted).toMatchObject({ complete: false, retained: [] });
    expect(converted.converted).toHaveLength(1);
    await expect(
      receiveClaimFoldOriginalInventoryTurn(env, accessPool, input()),
    ).rejects.toBeInstanceOf(ClaimStatementFoldUnavailable);
    // The retained progress still describes the original population, byte for byte.
    const replay = await receiveClaimFoldOriginalInventoryTurn(
      env,
      accessPool,
      input(captured.progress),
    );
    expect(replay.status === 'captured' && replay.original).toEqual(captured.original);
    console.log(
      JSON.stringify({
        case: 'claim-fold-original-inventory',
        total: captured.original.total,
        accessGeneration: fence.generation,
        contentGeneration: permit.generation,
        audit: captured.original.assessmentHistory.counts,
      }),
    );
  } finally {
    await account?.close();
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { readVerificationAssessmentHistory } from '../../../services/main/src/modules/access/assessment-history.ts';
import {
  claimDigest,
  createClaim,
  recordAssessment,
  readAssessment,
  readReceipt,
  type AssessmentRecordInput,
} from '../../../services/main/src/modules/verification/graph.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

test('Committed native assessment without Access acknowledgement or Content producer remains unresolved original custody', async () => {
  const run = Bun.env.REZICS_QA_RUN_ID,
    fusekiUrl = Bun.env.FUSEKI_URL;
  const dataEpoch = Bun.env.MAIN_DATA_EPOCH,
    routingEpoch = Bun.env.MAIN_ROUTING_EPOCH;
  if (!run || !fusekiUrl || !dataEpoch || !routingEpoch)
    throw new Error('Run through isolated QA integration');
  const databases = await cloneQaOwnerDatabases(run, ['access', 'content']);
  const access = new Pool({ connectionString: databases.urls.access, max: 1 });
  const content = new Pool({ connectionString: databases.urls.content, max: 1 });
  const directory = join(
    resolve(import.meta.dir, '../../..'),
    '.temp',
    `assessment-history-native-${randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    await migrateContent(content);
    const principal = randomUUID(),
      actor = `https://rezics.com/id/${randomUUID()}`;
    const env = {
      fuseki: new FusekiClient(fusekiUrl),
      lineage: { dataEpoch, routingEpoch },
      objectDirectory: directory,
    };
    await access.query(
      `INSERT INTO access.principal (id,account_issuer,account_subject)
      VALUES ($1,'https://assessment-history-native.test',$2)`,
      [principal, randomUUID()],
    );
    await access.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
      actor,
    ]);
    await access.query(`INSERT INTO access.scope_gate (id) VALUES ('verification:claim:global'),
      ('verification:assess:global') ON CONFLICT DO NOTHING`);
    const admitted = async (
      action: string,
      scope: string,
      digest: string,
    ): Promise<RegisteredAdmission> => {
      const admission = randomUUID(),
        key = randomUUID();
      const row = (
        await access.query<{ registered_at: Date; expires_at: Date }>(
          `INSERT INTO access.admission
        (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,
          authority_epoch,expires_at,state,claimed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,clock_timestamp()+interval '1 hour','claimed',clock_timestamp())
        RETURNING registered_at,expires_at`,
          [admission, principal, actor, scope, action, key, digest],
        )
      ).rows[0]!;
      return {
        id: admission,
        principalId: principal,
        actingSubject: actor,
        action,
        scope,
        idempotencyKey: key,
        requestDigest: digest,
        authorityEpoch: '0',
        registeredAt: row.registered_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        state: 'claimed',
        dispatchEligible: true,
        replayed: false,
      };
    };
    const claimInput = {
      referent: `urn:assessment-history:referent:${randomUUID()}`,
      interpretationContext: 'urn:assessment-history:context',
      propositionPredicate: 'urn:assessment-history:predicate',
      value: {
        kind: 'literal' as const,
        lexical: 'Retained exact claim',
        datatype: 'string' as const,
      },
      valuePrecision: 'exact' as const,
      valueQualifiers: [],
      validFrom: null,
      validUntil: null,
      editionScope: null,
      actingSubject: actor,
    };
    const claimAdmission = await admitted(
      'verification.claim-create',
      'verification:claim:global',
      claimDigest(claimInput),
    );
    const created = await createClaim(env, claimAdmission, claimInput);
    const claim = created.result.claim!,
      claimRevision = created.result.claimRevision!;
    const evidence = await new VerificationStore(content).recordEvidence(
      principal,
      randomUUID(),
      claim,
      { claimRevision, expectedHead: null, items: [] },
    );
    const input: AssessmentRecordInput = {
      claim,
      claimRevision,
      evidenceSetRevision: evidence.evidence.revision,
      sourceAssessments: [],
      method: 'urn:assessment-history:method',
      methodRevision: 'urn:assessment-history:method-v1',
      policyRevision: 'urn:assessment-history:policy-v1',
      evaluationContext: 'urn:assessment-history:context',
      coverage: 'complete',
      support: 'insufficient',
      dependence: 'unknown',
      independentOrigins: null,
      scorePerMillion: null,
      calibration: null,
      limitations: 'No original producer custody retained',
      assessorKind: 'human',
      actingSubject: actor,
    };
    const digest = createHash('sha256')
      .update(JSON.stringify({ input, expectedSummary: null, resolvesChallenges: [] }))
      .digest('hex');
    const admission = await admitted(
      'verification.claim-assess',
      'verification:assess:global',
      digest,
    );
    const native = await recordAssessment(env, admission, digest, input);
    expect(native.outcome).toBe('succeeded');
    const terminal = await readReceipt(env, admission.id, 'claim-assess', ['assessment']);
    expect(terminal).toMatchObject({
      outcome: 'succeeded',
      receipt: native.receipt,
      admissionId: admission.id,
      requestDigest: digest,
      authorityEpoch: admission.authorityEpoch,
      scope: admission.scope,
      dataEpoch: native.dataEpoch,
      sequence: native.sequence,
    });
    const assessment = await readAssessment(env, native.result.assessment!);
    expect(assessment).toMatchObject({
      claim,
      claimRevision,
      evidenceSetRevision: evidence.evidence.revision,
    });
    const originalProducers = (
      await content.query(
        'SELECT admission_id FROM verification.assessment_producer WHERE admission_id=$1',
        [admission.id],
      )
    ).rows;
    expect(originalProducers).toEqual([]);
    const client = await access.connect();
    let history: Awaited<ReturnType<typeof readVerificationAssessmentHistory>> | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const page = await readVerificationAssessmentHistory(client);
      history = page;
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        id: admission.id,
        nativeReceipt: terminal!.receipt,
        originalCustody: 'unknown',
        unresolved: ['in-flight'],
        facts: {
          state: 'claimed',
          graphReceipt: null,
          graphOutcome: null,
          graphDataEpoch: null,
          graphSequence: null,
        },
      });
      expect(page.rows[0]!.facts).not.toHaveProperty('claim');
      expect(page.rows[0]!.facts).not.toHaveProperty('claimRevision');
      expect(page.rows[0]!.facts).not.toHaveProperty('expectedSummary');
      expect(page.rows[0]!.facts).not.toHaveProperty('resolvesChallenges');
      expect(page.endOfHistory).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const retainedProducers = (
      await content.query(
        'SELECT admission_id FROM verification.assessment_producer WHERE admission_id=$1',
        [admission.id],
      )
    ).rows;
    expect(retainedProducers).toEqual([]);
    const root = resolve(import.meta.dir, '../../..');
    const evidenceDirectory = join(root, '.temp', 'assessment-history-evidence');
    mkdirSync(evidenceDirectory, { recursive: true });
    const sourceDigest = (path: string) =>
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
    writeFileSync(
      join(evidenceDirectory, `${run}-native.json`),
      JSON.stringify(
        {
          runId: run,
          readerSha256: sourceDigest('services/main/src/modules/access/assessment-history.ts'),
          testSha256: sourceDigest('tests/qa/integration/assessment-history-native.test.ts'),
          lineage: env.lineage,
          admission,
          terminal,
          assessment,
          originalProducerCount: originalProducers.length,
          retainedProducerCount: retainedProducers.length,
          emittedCount: history!.rows.length,
          history,
        },
        null,
        2,
      ),
    );
  } finally {
    await access.end();
    await content.end();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

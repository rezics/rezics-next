import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  AdmissionConflict,
  AdmissionDenied,
} from '../../../services/main/src/modules/access/admission.ts';
import { AccessRevocations } from '../../../services/main/src/modules/access/revocation-requests.ts';
import {
  AccessProposalExecutions,
  proposalReceiptIri,
  type ProposalExecutionBasis,
} from '../../../services/main/src/modules/proposal/access.ts';
import {
  governanceBodyScopeId,
  proposalExecutionAction,
} from '../../../services/main/src/modules/proposal/schema.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const requestDigest = 'a'.repeat(64);
const authorityDenied = 'current body mandate and capability grant required';

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.access });
  const principalId = randomUUID(),
    body = native(),
    target = native();
  const principal = { issuer: 'https://proposal-authority.test', subject: randomUUID() };
  const scope = governanceBodyScopeId(body),
    capabilityScope = `access:org-roster:${target.slice(-36)}`;
  await pool.query(
    'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject],
  );
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [body]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1),($2)', [scope, capabilityScope]);
  const mandate = async (action = proposalExecutionAction) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`,
      [id, principalId, body, action],
    );
    return id;
  };
  const grant = async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'access.org.roster.policy',clock_timestamp() + interval '1 hour')`,
      [id, body, capabilityScope],
    );
    return id;
  };
  const basis: ProposalExecutionBasis = {
    proposal: native(),
    proposalRevision: native(),
    resolution: native(),
    body,
    effectDigest: 'b'.repeat(64),
    effectTarget: target,
    expectedTargetState: 'c'.repeat(64),
    capability: 'access.org.roster.policy',
    capabilityScope,
    representationId: await mandate(),
    capabilityGrantId: await grant(),
  };
  return {
    pool,
    principal,
    principalId,
    body,
    scope,
    basis,
    mandate,
    grant,
    executions: new AccessProposalExecutions(pool),
    close: async () => {
      await pool.end();
      await databases.close();
    },
  };
}

test('Proposal execution retries replay unchanged authority and refuse an ordinarily revoked exact body grant', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      first = await f.executions.admit(f.principal, f.basis, key, requestDigest);
    expect(await f.executions.replay(f.principal, f.basis, key, requestDigest)).toMatchObject({
      id: first.id,
      replayed: true,
      dispatchEligible: true,
    });
    expect(await f.executions.admit(f.principal, f.basis, key, requestDigest)).toMatchObject({
      id: first.id,
      replayed: true,
      dispatchEligible: true,
    });
    const witness = (
      await f.pool.query('SELECT authority_witness FROM access.admission WHERE id = $1', [first.id])
    ).rows[0].authority_witness;
    expect(witness).toEqual([
      { table: 'principal', id: f.principalId, generation: '0' },
      { table: 'authority_subject', id: f.body, generation: '0' },
      { table: 'representation', id: f.basis.representationId, generation: '0' },
      { table: 'permission_grant', id: f.basis.capabilityGrantId, generation: '0' },
    ]);
    await f.mandate('access.revoke');
    await new AccessRevocations(f.pool).revoke(
      f.principal,
      {
        revocationId: randomUUID(),
        issuerSubject: f.body,
        scopeId: f.basis.capabilityScope,
        expectedAuthorityEpoch: '0',
        mode: 'ordinary',
        target: {
          kind: 'permission_grant',
          id: f.basis.capabilityGrantId,
          expectedGeneration: '0',
        },
      },
      { idempotencyKey: randomUUID(), requestDigest: 'd'.repeat(64) },
    );
    expect(
      (await f.pool.query('SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [f.scope]))
        .rows[0].authority_epoch,
    ).toBe('0');
    for (const method of ['replay', 'admit'] as const) {
      await expect(f.executions[method](f.principal, f.basis, key, requestDigest)).rejects.toThrow(
        authorityDenied,
      );
    }
    const freshBasis = {
      ...f.basis,
      proposal: native(),
      proposalRevision: native(),
      resolution: native(),
    };
    await expect(
      f.executions.admit(f.principal, freshBasis, randomUUID(), requestDigest),
    ).rejects.toThrow(authorityDenied);
    const replacement = { ...freshBasis, capabilityGrantId: await f.grant() };
    expect(
      (await f.executions.admit(f.principal, replacement, randomUUID(), requestDigest))
        .dispatchEligible,
    ).toBe(true);
    await expect(
      f.executions.replay(
        f.principal,
        { ...f.basis, capabilityGrantId: replacement.capabilityGrantId },
        key,
        requestDigest,
      ),
    ).rejects.toBeInstanceOf(AdmissionConflict);
  } finally {
    await f.close();
  }
}, 30_000);

test('Proposal execution retries pin each source generation and refuse expired or inactive authority', async () => {
  const f = await fixture();
  try {
    for (const [table, id, change, restore] of [
      [
        'permission_grant',
        f.basis.capabilityGrantId,
        "valid_until = valid_until + interval '1 second'",
        null,
      ],
      [
        'representation',
        f.basis.representationId,
        "valid_until = valid_until + interval '1 second'",
        null,
      ],
      ['authority_subject', f.body, 'generation = generation + 1', null],
      ['principal', f.principalId, 'enforcement_epoch = enforcement_epoch + 1', null],
      ['representation', f.basis.representationId, 'active = false', 'active = true'],
      [
        'permission_grant',
        f.basis.capabilityGrantId,
        "valid_until = clock_timestamp() - interval '1 second'",
        "valid_until = clock_timestamp() + interval '1 hour'",
      ],
      ['authority_subject', f.body, 'active = false', 'active = true'],
      ['principal', f.principalId, 'active = false', 'active = true'],
    ] as const) {
      const basis = {
        ...f.basis,
        proposal: native(),
        proposalRevision: native(),
        resolution: native(),
      };
      const key = randomUUID();
      await f.executions.admit(f.principal, basis, key, requestDigest);
      await f.pool.query(`UPDATE access.${table} SET ${change} WHERE id = $1`, [id]);
      for (const method of ['replay', 'admit'] as const) {
        await expect(
          f.executions[method](f.principal, basis, key, requestDigest),
        ).rejects.toBeInstanceOf(AdmissionDenied);
      }
      if (restore) await f.pool.query(`UPDATE access.${table} SET ${restore} WHERE id = $1`, [id]);
    }
  } finally {
    await f.close();
  }
}, 30_000);

test('Proposal execution retries refuse changed or closed scope gates and preserve sealed replay with unchanged authority', async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      first = await f.executions.admit(f.principal, f.basis, key, requestDigest);
    await f.executions.seal(first, {
      admissionId: first.id,
      scope: first.scope,
      requestDigest,
      authorityEpoch: first.authorityEpoch,
      receipt: proposalReceiptIri(first.id),
      outcome: 'succeeded',
      dataEpoch: 'proposal-authority-fixture',
      sequence: '1',
    });
    await f.pool.query(
      "UPDATE access.admission SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [first.id],
    );
    expect(await f.executions.replay(f.principal, f.basis, key, requestDigest)).toMatchObject({
      id: first.id,
      replayed: true,
      state: 'sealed',
      dispatchEligible: false,
    });
    for (const dispatchOpen of [true, false]) {
      await f.pool.query(
        'UPDATE access.scope_gate SET open = false, dispatch_open = $2 WHERE id = $1',
        [f.scope, dispatchOpen],
      );
      for (const method of ['replay', 'admit'] as const) {
        await expect(
          f.executions[method](f.principal, f.basis, key, requestDigest),
        ).rejects.toThrow('body execution gate is closed');
      }
      await f.pool.query(
        'UPDATE access.scope_gate SET open = true, dispatch_open = true WHERE id = $1',
        [f.scope],
      );
    }
    await f.pool.query(
      'UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1',
      [f.scope],
    );
    for (const method of ['replay', 'admit'] as const) {
      await expect(f.executions[method](f.principal, f.basis, key, requestDigest)).rejects.toThrow(
        'body execution gate is closed',
      );
    }
  } finally {
    await f.close();
  }
}, 30_000);

test('Proposal admissions without a shared witness still fence retries using their immutable owner proof', async () => {
  const f = await fixture(),
    client = await f.pool.connect();
  try {
    const original = await f.executions.admit(f.principal, f.basis, randomUUID(), requestDigest);
    const legacyId = randomUUID(),
      key = randomUUID();
    const basis = {
      ...f.basis,
      proposal: native(),
      proposalRevision: native(),
      resolution: native(),
    };
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
      idempotency_key,request_digest,authority_epoch,expires_at,state,claimed_at)
      SELECT $2::uuid,principal_id,acting_subject,scope_id,action,$3,request_digest,authority_epoch,
        expires_at,state,claimed_at FROM access.admission WHERE id = $1`,
      [original.id, legacyId, key],
    );
    await client.query(
      `INSERT INTO access.proposal_execution_admission
      SELECT (jsonb_populate_record(NULL::access.proposal_execution_admission,
        to_jsonb(p) || jsonb_build_object('admission_id',$2::text,'proposal',$3::text,
          'proposal_revision',$4::text,'resolution',$5::text))).*
      FROM access.proposal_execution_admission p WHERE admission_id = $1`,
      [original.id, legacyId, basis.proposal, basis.proposalRevision, basis.resolution],
    );
    await client.query('COMMIT');
    expect(
      (
        await f.pool.query('SELECT authority_witness FROM access.admission WHERE id = $1', [
          legacyId,
        ])
      ).rows[0].authority_witness,
    ).toBeNull();
    expect(await f.executions.replay(f.principal, basis, key, requestDigest)).toMatchObject({
      id: legacyId,
      replayed: true,
      dispatchEligible: true,
    });
    await f.pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      basis.capabilityGrantId,
    ]);
    for (const method of ['replay', 'admit'] as const) {
      await expect(f.executions[method](f.principal, basis, key, requestDigest)).rejects.toThrow(
        authorityDenied,
      );
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await f.close();
  }
}, 30_000);

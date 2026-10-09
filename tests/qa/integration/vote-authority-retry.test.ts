import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { AccessVotes, voteReceiptIri, type VoteAuthority } from '../../../services/main/src/modules/vote/access.ts';
import { pollScopeId } from '../../../services/main/src/modules/vote/schema.ts';
import { AccessRevocations } from '../../../services/main/src/modules/access/revocation-requests.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access'], 'owner');
  const pool = new Pool({ connectionString: databases.urls.access });
  const principalId = randomUUID(), actor = native(), poll = native(), scope = pollScopeId(poll);
  const principal = { issuer: 'https://vote-authority.test', subject: randomUUID() };
  await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)`,
    [principalId, principal.issuer, principal.subject]);
  await pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [actor]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  const mandate = async (action: string) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [id, principalId, actor, action]);
    return id;
  };
  const grant = async (action: string) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [id, actor, scope, action]);
    return id;
  };
  const authority: VoteAuthority = { operation: 'poll.open', poll, body: actor, actingSubject: actor,
    representationId: await mandate('governance.poll.administer'), grantId: await grant('governance.poll.administer'),
    candidateDigest: 'b'.repeat(64), expectedHead: null };
  return { pool, principalId, principal, actor, scope, authority, mandate, grant, votes: new AccessVotes(pool),
    close: async () => { await pool.end(); await databases.close(); } };
}

test('A vote retry after ordinary body-grant revocation cannot dispatch or substitute another live grant', async () => {
  const f = await fixture();
  try {
    await f.mandate('access.revoke'); await f.grant('access.revoke');
    const key = randomUUID(), digest = 'a'.repeat(64);
    const saved = await f.votes.admit(f.principal, f.authority, key, digest);
    expect(saved.dispatchEligible).toBe(true);
    expect((await f.votes.admit(f.principal, f.authority, key, digest)).dispatchEligible).toBe(true);
    await new AccessRevocations(f.pool).revoke(f.principal, { revocationId: randomUUID(),
      issuerSubject: f.actor, scopeId: f.scope, expectedAuthorityEpoch: '0', mode: 'ordinary',
      target: { kind: 'permission_grant', id: f.authority.grantId!, expectedGeneration: '0' } },
    { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) });
    const replacement = { ...f.authority, grantId: await f.grant('governance.poll.administer') };
    expect(await f.votes.admit(f.principal, replacement, key, digest))
      .toMatchObject({ id: saved.id, replayed: true, dispatchEligible: false });
    expect((await f.votes.admit(f.principal, replacement, randomUUID(), digest)).dispatchEligible).toBe(true);
    expect((await f.pool.query('SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [f.scope])).rows[0].authority_epoch).toBe('0');
    const witness = (await f.pool.query('SELECT authority_witness FROM access.admission WHERE id = $1', [saved.id])).rows[0].authority_witness;
    expect(witness).toContainEqual({ table: 'permission_grant', id: f.authority.grantId, generation: '0' });
    expect(witness).toContainEqual({ table: 'representation', id: f.authority.representationId, generation: '0' });
  } finally { await f.close(); }
}, 30_000);

test('Vote retries pin body-grant and mandate generations even while both sources remain active', async () => {
  const f = await fixture();
  try {
    const digest = 'a'.repeat(64), firstKey = randomUUID();
    const first = await f.votes.admit(f.principal, f.authority, firstKey, digest);
    await f.pool.query("UPDATE access.permission_grant SET valid_until = valid_until + interval '1 second' WHERE id = $1", [f.authority.grantId]);
    expect(await f.votes.admit(f.principal, f.authority, firstKey, digest)).toMatchObject({ id: first.id, dispatchEligible: false });
    const secondKey = randomUUID(), second = await f.votes.admit(f.principal, f.authority, secondKey, digest);
    expect(second.dispatchEligible).toBe(true);
    await f.pool.query("UPDATE access.representation SET valid_until = valid_until + interval '1 second' WHERE id = $1", [f.authority.representationId]);
    expect(await f.votes.admit(f.principal, f.authority, secondKey, digest)).toMatchObject({ id: second.id, dispatchEligible: false });
    expect((await f.votes.admit(f.principal, f.authority, randomUUID(), digest)).dispatchEligible).toBe(true);
  } finally { await f.close(); }
}, 30_000);


test('Votes saved before authority witnesses still refuse replay after their exact body grant changes', async () => {
  const f = await fixture(), client = await f.pool.connect();
  try {
    const digest = 'a'.repeat(64), original = await f.votes.admit(f.principal, f.authority, randomUUID(), digest);
    const legacyId = randomUUID(), legacyKey = randomUUID();
    await client.query('BEGIN');
    await client.query(`INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
      idempotency_key,request_digest,authority_epoch,expires_at,state,claimed_at)
      SELECT $2::uuid,principal_id,acting_subject,scope_id,action,$3,request_digest,authority_epoch,
        expires_at,state,claimed_at FROM access.admission WHERE id = $1`, [original.id, legacyId, legacyKey]);
    await client.query(`INSERT INTO access.vote_admission
      SELECT (jsonb_populate_record(NULL::access.vote_admission,
        to_jsonb(v) || jsonb_build_object('admission_id',$2::text))).*
      FROM access.vote_admission v WHERE admission_id = $1`, [original.id, legacyId]);
    await client.query('COMMIT');
    expect(await f.votes.admit(f.principal, f.authority, legacyKey, digest))
      .toMatchObject({ id: legacyId, dispatchEligible: true });
    await f.pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [f.authority.grantId]);
    expect(await f.votes.admit(f.principal, f.authority, legacyKey, digest))
      .toMatchObject({ id: legacyId, dispatchEligible: false });
  } finally { await client.query('ROLLBACK'); client.release(); await f.close(); }
}, 30_000);

test('Strong body-grant revocation drains a witnessed vote and completes after its terminal receipt', async () => {
  const f = await fixture();
  try {
    await f.mandate('access.revoke');
    const key = randomUUID(), digest = 'a'.repeat(64), saved = await f.votes.admit(f.principal, f.authority, key, digest);
    const revocations = new AccessRevocations(f.pool);
    const cut = await revocations.revoke(f.principal, { revocationId: randomUUID(), issuerSubject: f.actor,
      scopeId: f.scope, expectedAuthorityEpoch: '0', mode: 'strong',
      target: { kind: 'permission_grant', id: f.authority.grantId!, expectedGeneration: '0' } },
    { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) });
    expect(cut).toMatchObject({ state: 'draining', affectedWork: 1, pending: 1 });
    expect((await f.votes.admit(f.principal, f.authority, key, digest)).dispatchEligible).toBe(false);
    await f.votes.seal(saved, { admissionId: saved.id, scope: saved.scope, requestDigest: digest,
      authorityEpoch: saved.authorityEpoch, receipt: voteReceiptIri(saved.id, saved.operation),
      outcome: 'cancelled', dataEpoch: 'vote-authority-fixture', sequence: '1' });
    expect(await revocations.read(f.principal, f.actor, cut.revocationId)).toMatchObject({ state: 'completed', pending: 0 });
    expect(await f.votes.admit(f.principal, f.authority, key, digest)).toMatchObject({ state: 'sealed', dispatchEligible: false });
  } finally { await f.close(); }
}, 30_000);

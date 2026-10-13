import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from './admission.ts';
import { grantFixtureAuthority } from './fixture-authority.ts';
import { erasureReceiptIri } from '../erasure/request.ts';
import { RANKING_POLICY } from '../recommendation/ranking.ts';

interface RecoveryFixtureInput {
  principalId: string;
  actor: string;
  resource: string;
  scope: string;
  generationId: string;
  rateKey: string;
  dataEpoch: string;
  suffix: string;
}

/** The Access fixture owner installs disposable caches and counters, while
 * admissions always run the registry's witness, receipt and outbox commands. */
export async function prepareAccessErasureRecoveryFixture(pool: Pool, input: RecoveryFixtureInput) {
  const { principalId, actor, resource, scope, generationId, rateKey, dataEpoch, suffix } = input;
  const principal: VerifiedPrincipal = { issuer: `https://qa-${suffix}.local`, subject: `erasure-${suffix}` };
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  await grantFixtureAuthority(pool, { scope, requireDispatch: true,
    representations: [{ principalId, actor, action: 'erasure.request', lifetime: '8 hours' }],
    grant: { actor, action: 'erasure.request', lifetime: '8 hours' } });
  const registry = new AccessAdmissionRegistry(pool);
  const probe = await registry.register({ principal, actingSubject: actor, scope,
    action: 'erasure.request', idempotencyKey: `base-${suffix}`, requestDigest: rateKey });
  await pool.query(`INSERT INTO access.realm_directory
    (realm, space, profile, created, activity, search_text, count_kind, count_value)
    VALUES ($1, $1, '{"number":9007199254740992}'::jsonb, 0, 0, '', 'unknown', -1)`, [resource]);
  await pool.query(`UPDATE access.realm_directory_position SET data_epoch = 'old-cut', sequence = 7,
    build_data_epoch = 'old-cut', rebuilding = false WHERE singleton`);
  await pool.query(`INSERT INTO access.rate_limit_v1 (key, family, count, expires_at)
    VALUES ($1, 'write', 1, clock_timestamp() + interval '1 hour')`, [rateKey]);
  await pool.query(`INSERT INTO access.derived_generation
    (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
    VALUES ($1, 'ranking', $2, $2, $3::jsonb, clock_timestamp() + interval '1 hour')`,
    [generationId, rateKey, JSON.stringify({ source: { dataEpoch, snapshotTarget: '0', zeroSnapshot: '0' } })]);
  await pool.query(`INSERT INTO access.derived_generation_input
    (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence)
    VALUES ($1, 'main-graph', $2, 0, 0)`, [generationId, dataEpoch]);
  await pool.query(`INSERT INTO access.ranking_generation
    (generation_id, population, candidate_grain, score_policy, partition_count)
    VALUES ($1, 'public', 'work', $2, 1)`, [generationId, RANKING_POLICY]);
  await pool.query(`INSERT INTO access.ranking_partition (generation_id, partition) VALUES ($1, 0)`, [generationId]);
  await pool.query(`INSERT INTO access.discovery_refresh (scope_key, basis, lease_epoch)
    VALUES ($1, '{"scope":"global"}'::jsonb, 1)`, [rateKey]);
  const cleanupGenerationId = randomUUID();
  await pool.query(`INSERT INTO access.derived_generation
    (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
    VALUES ($1, 'discovery', $2, $2, '{}'::jsonb, clock_timestamp())`, [cleanupGenerationId, rateKey]);
  await pool.query(`INSERT INTO access.discovery_generation
    (generation_id, scope, source_epoch, source_sequence, access_revision, recovery_generation)
    VALUES ($1, 'global', $2, 0, 0, '0')`, [cleanupGenerationId, dataEpoch]);
  await pool.query(`UPDATE access.derived_generation SET state = 'failed', lease_expires_at = NULL,
    failure_reason = 'fixture-retired', finished_at = clock_timestamp() WHERE id = $1`, [cleanupGenerationId]);
  return { principal, probeId: probe.id, cleanupGenerationId };
}

export async function advanceAccessErasureRecoveryFixture(pool: Pool,
  input: Pick<RecoveryFixtureInput, 'generationId' | 'rateKey' | 'resource'>): Promise<void> {
  await pool.query(`UPDATE access.realm_directory SET profile = '{"number":9007199254740993}'::jsonb
    WHERE realm = $1`, [input.resource]);
  await pool.query(`UPDATE access.realm_directory_position SET sequence = 12, phase = 'graph',
    target_sequence = 20, refresh_after = 'partial' WHERE singleton`);
  await pool.query('UPDATE access.rate_limit_v1 SET count = count + 1 WHERE key = $1', [input.rateKey]);
  await pool.query(`UPDATE access.derived_generation SET lease_epoch = lease_epoch + 2,
    lease_expires_at = clock_timestamp() + interval '2 hours' WHERE id = $1`, [input.generationId]);
  await pool.query(`UPDATE access.derived_generation_input SET checkpoint_sequence = 7,
    checkpoint_event = 'progress', snapshot_complete = true WHERE generation_id = $1`, [input.generationId]);
  await pool.query(`UPDATE access.discovery_refresh SET lease_epoch = 3, attempts = 3,
    due_at = clock_timestamp() + interval '2 hours' WHERE scope_key = $1`, [input.rateKey]);
}

export async function prepareTerminalErasureAdmissionsFixture(pool: Pool, input: {
  principal: VerifiedPrincipal; actor: string; scope: string; dataEpoch: string;
  requests: readonly { idempotencyKey: string; requestDigest: string; sequence: string }[];
}): Promise<string[]> {
  const registry = new AccessAdmissionRegistry(pool);
  const ids: string[] = [];
  for (const request of input.requests) {
    const registered = await registry.register({ principal: input.principal, actingSubject: input.actor,
      scope: input.scope, action: 'erasure.request', idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest });
    await registry.claim(registered.id, request.requestDigest, input.principal);
    await registry.recordGraphOutcome(registered.id, { admissionId: registered.id, scope: input.scope,
      requestDigest: request.requestDigest, authorityEpoch: registered.authorityEpoch,
      receipt: erasureReceiptIri(registered.id), outcome: 'succeeded', dataEpoch: input.dataEpoch,
      sequence: request.sequence });
    ids.push(registered.id);
  }
  return ids;
}

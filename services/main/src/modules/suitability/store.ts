import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { platformAdministratorProof } from '../access/platform-administrator.ts';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import {
  controlRead,
  controlTransaction,
  ControlConflict,
  ControlDenied,
  ControlInvalid,
  ControlStale,
  lockGate,
  requireCeiling,
  requireMandate,
  requirePrincipal,
} from '../access/topology-control.ts';
import { resolvedTarget, targetRef, type ResolvedTarget } from '../target/contract.ts';
import { resolveCommandTarget, targetRead } from '../target/resolve.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { command, type Assessed, type Command, type ReadAssessment } from './contract.ts';
import { atLeastAsRestrictive, UNASSESSED, type Labels } from './policy.ts';

export const PLATFORM_SCOPE = 'governance:platform';
export const PLATFORM_ACTION = 'governance.moderate';
/** Resolution uses TARGET_RESOLVE_COST. Assessment reads add one SQL batch of
 * at most 64 indexed latest-revision probes, independent of retained history.
 * Writes add two advisory locks, replay/head/platform probes and one insert;
 * Access proof queries and the recovery envelope are additional fixed costs. */
export const SUITABILITY_COST = {
  targets: 64,
  readStatements: 1,
  moderatorAuthorityStatements: 5,
  writeStatements: 6,
  commandTargetQueries: 3,
  lockTimeoutMs: 2000,
  statementTimeoutMs: 5000,
} as const;
interface Row {
  id: string;
  target: string;
  labels: Labels;
  basis: 'author' | 'platform' | 'source';
  source_id: string | null;
  assessor: string;
  predecessor: string | null;
  revision_number: string;
  request_digest: string;
  created_at: Date;
}
const native = (id: string) => `https://rezics.com/id/${id}`;
function serialize(row: Row): Assessed {
  return {
    status: 'assessed',
    revision: native(row.id),
    predecessor: row.predecessor ? native(row.predecessor) : null,
    labels: row.labels,
    basis: row.basis,
    sourceId: row.source_id,
    assessor: row.assessor,
    createdAt: row.created_at.toISOString(),
  };
}
type AuthorAuthority = {
  withWorkEditAuthority<T>(
    principal: VerifiedPrincipal,
    actor: string,
    work: string,
    commit: (proof: WorkEditAuthorityProof) => Promise<T>,
  ): Promise<T>;
};

export class SuitabilityStore {
  constructor(
    private readonly pool: Pool,
    private readonly authorAuthority: AuthorAuthority,
  ) {}

  /** Call only after target admission. Never expose assessments of unavailable targets. */
  async read(
    targets: readonly ResolvedTarget[],
    reader?: { principal: VerifiedPrincipal; actingSubject: string },
  ): Promise<ReadAssessment[]> {
    if (
      !targets.length ||
      targets.length > SUITABILITY_COST.targets ||
      targets.some((target) => !Value.Check(resolvedTarget, target))
    )
      throw new ControlInvalid('Invalid suitability targets');
    return controlRead(this.pool, async (client) => {
      // OAuth consent is checked by the route; Access decides actual authority.
      // Keep the live grant/controller locks through reading and serialization.
      let discloseAssessor = false;
      if (reader) {
        try {
          const owner = await requirePrincipal(client, reader.principal);
          await lockGate(client, PLATFORM_SCOPE, false);
          if (!await platformAdministratorProof(client, owner.id, reader.actingSubject,true,
            { action: PLATFORM_ACTION,scope: PLATFORM_SCOPE })) {
            await requireMandate(client, owner.id, reader.actingSubject, PLATFORM_ACTION);
            await requireCeiling(client, reader.actingSubject, PLATFORM_ACTION, undefined, PLATFORM_SCOPE);
          }
          discloseAssessor = true;
        } catch (error) {
          if (!(error instanceof ControlDenied)) throw error;
        }
      }
      const rows = (
        await client.query<Row>(
          `SELECT a.* FROM unnest($1::text[]) AS requested(target)
        CROSS JOIN LATERAL (SELECT * FROM access.suitability_assessment a
          WHERE a.target = requested.target ORDER BY revision_number DESC LIMIT 1) a`,
          [[...new Set(targets.map((target) => target.resource))]],
        )
      ).rows;
      const byTarget = new Map(
        rows.map((row): [string, ReadAssessment] => {
          const value = serialize(row);
          if (discloseAssessor) return [row.target, value];
          const { assessor: _assessor, ...publicValue } = value;
          return [row.target, publicValue];
        }),
      );
      return targets.map((target) => byTarget.get(target.resource) ?? UNASSESSED);
    });
  }

  write(
    principal: VerifiedPrincipal,
    target: ResolvedTarget,
    input: Command,
    key: string,
  ): Promise<{ assessment: Assessed; replayed: boolean }> {
    return this.writeWithTarget(principal, target, input, key);
  }

  /** A suitability command needs structural identity, not permission to read
   * rated content. Platform authority is locked before resolving that identity;
   * author commands retain the owning Work's edit proof and platform floor. */
  writeCommand(principal: VerifiedPrincipal, resource: string, input: Command, key: string,
    environment: WorkActivationEnvironment): Promise<{ assessment: Assessed; replayed: boolean }> {
    if (!Value.Check(targetRef, resource)) throw new ControlInvalid('Invalid suitability target');
    return this.writeWithTarget(principal,
      () => targetRead(environment, {}, session => resolveCommandTarget(session, resource)), input, key);
  }

  private async writeWithTarget(
    principal: VerifiedPrincipal,
    targetProof: ResolvedTarget | (() => Promise<ResolvedTarget>),
    input: Command,
    key: string,
  ): Promise<{ assessment: Assessed; replayed: boolean }> {
    if (
      (typeof targetProof !== 'function' && !Value.Check(resolvedTarget, targetProof)) ||
      !Value.Check(command, input) ||
      !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)
    )
      throw new ControlInvalid('Invalid suitability command');
    const resolve = async () => {
      const target = typeof targetProof === 'function' ? await targetProof() : targetProof;
      if (!Value.Check(resolvedTarget, target)) throw new ControlInvalid('Invalid suitability target proof');
      return target;
    };
    const digest = (target: ResolvedTarget) => createHash('sha256')
      .update(
        JSON.stringify([
          target.resource,
          input.actingSubject,
          input.expectedRevision,
          input.labels,
          input.basis,
        ]),
      )
      .digest('hex');
    if (input.basis === 'author') {
      const target = await resolve();
      if (!target.work) throw new ControlDenied('Author assessment requires an owning Work');
      return this.authorAuthority.withWorkEditAuthority(
        principal,
        input.actingSubject,
        target.work,
        (proof) =>
          controlTransaction(this.pool, (client) =>
            this.append(
              client,
              proof.principalId,
              target.resource,
              input,
              key,
              digest(target),
              proof,
              proof.validUntil,
            ),
          ),
      );
    }
    // Reuse Access's existing platform moderation action and guards; a Realm
    // grant can never authorize a platform suitability assessment.
    return controlTransaction(this.pool, async (client) => {
      const owner = await requirePrincipal(client, principal);
      const authorityEpoch = await lockGate(client, PLATFORM_SCOPE, false);
      const administrator = await platformAdministratorProof(client, owner.id, input.actingSubject,true,
        { action: PLATFORM_ACTION,scope: PLATFORM_SCOPE });
      if (administrator) {
        const target = await resolve();
        const lease = (await client.query<{ valid_until: Date }>(
          "SELECT clock_timestamp() + interval '15 seconds' AS valid_until")).rows[0]!;
        return this.append(client, owner.id, target.resource, input, key, digest(target),
          { principalId: owner.id, principalEpoch: owner.epoch, actingSubject: input.actingSubject,
            authorityEpoch, scope: PLATFORM_SCOPE, action: PLATFORM_ACTION, administrator,
            validUntil: lease.valid_until.toISOString() }, lease.valid_until.toISOString());
      }
      const mandate = await requireMandate(client, owner.id, input.actingSubject, PLATFORM_ACTION);
      const grant = await requireCeiling(
        client,
        input.actingSubject,
        PLATFORM_ACTION,
        undefined,
        PLATFORM_SCOPE,
      );
      const target = await resolve();
      // Access permits infinite mandates. Cap the lease in SQL so PostgreSQL
      // infinity never reaches JavaScript date arithmetic or the audit proof.
      const lease = (
        await client.query<{ valid_until: Date }>(
          `SELECT
        LEAST(r.valid_until, g.valid_until, clock_timestamp() + interval '15 seconds') AS valid_until
        FROM access.representation r JOIN access.permission_grant g ON g.id = $2
        WHERE r.id = $1 AND LEAST(r.valid_until, g.valid_until) > clock_timestamp()`,
          [mandate.id, grant.id],
        )
      ).rows[0];
      if (!lease) throw new ControlDenied('Platform suitability authority expired');
      return this.append(
        client,
        owner.id,
        target.resource,
        input,
        key,
        digest(target),
        {
          principalId: owner.id,
          principalEpoch: owner.epoch,
          actingSubject: input.actingSubject,
          authorityEpoch,
          scope: PLATFORM_SCOPE,
          action: PLATFORM_ACTION,
          mandate: { id: mandate.id, generation: mandate.generation },
          grant: { id: grant.id, generation: grant.generation },
          validUntil: lease.valid_until.toISOString(),
        },
        lease.valid_until.toISOString(),
      );
    });
  }

  private async append(
    client: PoolClient,
    principalId: string,
    target: string,
    input: Command,
    key: string,
    digest: string,
    proof: unknown,
    validUntil: string,
  ): Promise<{ assessment: Assessed; replayed: boolean }> {
    // Consistent key-then-target lock order serializes absent heads and retries.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `suitability-key:${principalId}:${key}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `suitability-target:${target}`,
    ]);
    const prior = (
      await client.query<Row>(
        `SELECT * FROM access.suitability_assessment
      WHERE principal_id = $1 AND idempotency_key = $2`,
        [principalId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_digest !== digest)
        throw new ControlConflict('Suitability key has another intent');
      return { assessment: serialize(prior), replayed: true };
    }
    const head = (
      await client.query<Row>(
        `SELECT * FROM access.suitability_assessment
      WHERE target = $1 ORDER BY revision_number DESC LIMIT 1`,
        [target],
      )
    ).rows[0];
    if ((head ? native(head.id) : null) !== input.expectedRevision)
      throw new ControlStale('Suitability revision changed');
    if (input.basis === 'author') {
      const platform = (
        await client.query<Row>(
          `SELECT * FROM access.suitability_assessment
        WHERE target = $1 AND basis = 'platform' ORDER BY revision_number DESC LIMIT 1`,
          [target],
        )
      ).rows[0];
      // Keep the platform floor after a stronger author correction as well.
      if (platform && !atLeastAsRestrictive(input.labels, platform.labels)) {
        throw new ControlDenied('Author assessment cannot weaken platform restrictions');
      }
    }
    const row = (
      await client.query<Row>(
        `INSERT INTO access.suitability_assessment
      (id,target,labels,basis,assessor,principal_id,predecessor,predecessor_number,revision_number,
       authority_proof,idempotency_key,request_digest) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       WHERE clock_timestamp() < $13::timestamptz RETURNING *`,
        [
          Bun.randomUUIDv7(),
          target,
          input.labels,
          input.basis,
          input.actingSubject,
          principalId,
          head?.id ?? null,
          head?.revision_number ?? null,
          (BigInt(head?.revision_number ?? '0') + 1n).toString(),
          proof,
          key,
          digest,
          validUntil,
        ],
      )
    ).rows[0];
    if (!row) throw new ControlDenied('Suitability authority expired before the write');
    return { assessment: serialize(row), replayed: false };
  }
}

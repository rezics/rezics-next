import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { definitionCreatorAllowed } from './definition-creator.ts';
import {
  PLATFORM_SCOPE,
  platformPermissionProof,
  platformPermissionDigest,
  readPlatformPermissions,
  findPlatformPermission,
} from './platform-permissions.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { questionContextPattern } from '../rating/question-presentation-context.ts';
import { ratingQuestionPresentationAction } from './rating-question-presentation.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** A syntactic candidate only. The exact action and scope must be held as an
 * ordinary resource grant below; being an administrator supplies no action. */
export function platformAdministratorAction(action: string, scope: string): boolean {
  return /^[a-z][a-z0-9.-]{0,99}$/.test(action) && /^[^\s\0]{1,256}$/.test(scope);
}

/** Resource authority covers this administrator's Zones and definitions, and
 * active questions owned by the Global rating population.
 * Work/Collection reads and edits retain their ordinary curator/creator policy.
 * Cost: the bounded definition-creation proof for definition read/edit, with
 * one exact 1 KiB Zone or Global question ASK when another resource is named.
 * A missing Zone can only be created: its owner command checks the Space owner. */
export async function platformAdministratorTargetAllowed(
  client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined,
  principal: string,
  actor: string,
  action: string,
  scope: string,
): Promise<boolean> {
  if (!platformAdministratorAction(action, scope)) return false;
  const permission = await platformPermissionProof(
    client,
    principal,
    `platform:resource:${action}`,
    scope,
  );
  if (!permission) return false;
  if (permission.scope_id === scope) return true;
  if (['media.labels.protect', 'media.conceal.protect'].includes(action)) return true;
  if (!graph || !native.test(actor)) return false;
  const target = scope.slice(scope.indexOf('https://rezics.com/id/'));
  if (ratingQuestionPresentationAction(action)) {
    return (
      (
        await graph.query(
          `PREFIX rv: <https://rezics.com/vocab/> ASK {
      ${questionContextPattern(target)} FILTER(?questionOwner = ${iri(GLOBAL_RATING_POPULATION_OWNER)})
    }`,
          1024,
        )
      ).boolean === true
    );
  }
  if (scope.startsWith('semantic:edit:')) {
    return definitionCreatorAllowed(client, graph, principal, actor, target);
  }
  if (
    action === 'semantic.read' &&
    (await definitionCreatorAllowed(client, graph, principal, actor, target))
  ) {
    return true;
  }
  return (
    (
      await graph.query(
        `PREFIX rv: <https://rezics.com/vocab/> ASK {
    { GRAPH ${iri(GRAPHS.current)} { ${iri(target)} a rv:Zone ; rv:space ?space .
      ?space a rv:Space ; rv:owner ${iri(actor)} . } }
    ${
      action === 'zone.edit'
        ? `UNION { FILTER NOT EXISTS {
      GRAPH ${iri(GRAPHS.current)} { ${iri(target)} ?p ?o } } }`
        : ''
    }
  }`,
        1024,
      )
    ).boolean === true
  );
}

export interface PlatformAdministratorProof {
  receipt: string;
  representation_id: string;
  representation_generation: string;
  subject_generation: string;
  principal_epoch: string;
}

/** The bounded platform grant proof plus one exact live controller. Its digest
 * pins grant and group episodes; the legacy singleton is never authority. */
export async function platformAdministratorProof(
  client: Pick<PoolClient, 'query'>,
  principalId: string,
  actor: string,
  lock = true,
  resource?: { action: string; scope: string },
): Promise<PlatformAdministratorProof | null> {
  if (!native.test(actor)) return null;
  if (lock)
    await client.query('SELECT id FROM access.scope_gate WHERE id = $1 FOR SHARE', [
      PLATFORM_SCOPE,
    ]);
  const permissions = await readPlatformPermissions(client, principalId);
  const grant = findPlatformPermission(permissions, 'platform:use:platform-admin');
  if (!grant) return null;
  const resourceGrant = resource
    ? findPlatformPermission(permissions, `platform:resource:${resource.action}`, resource.scope)
    : null;
  if (resource && !resourceGrant) return null;
  // Admissions made by the existing owner API pin the entire bounded resource
  // authority basis. Replacing a revoked resource episode cannot revive them.
  const receipt = `urn:rezics:access-receipt:${createHash('sha256')
    .update(
      JSON.stringify([
        platformPermissionDigest(grant),
        permissions
          .filter((permission) => permission.action.startsWith('platform:resource:'))
          .map(platformPermissionDigest)
          .sort(),
      ]),
    )
    .digest('hex')}`;
  return (
    (
      await client.query<PlatformAdministratorProof>(
        `SELECT $3::text AS receipt,
      r.id AS representation_id, r.generation AS representation_generation,
      s.generation AS subject_generation, p.enforcement_epoch AS principal_epoch
    FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
    WHERE p.active AND p.id = $1 AND r.subject_id = $2 AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp()
    ORDER BY r.id LIMIT 1${lock ? ' FOR SHARE OF p,r,s' : ''}`,
        [principalId, actor, receipt],
      )
    ).rows[0] ?? null
  );
}

export async function savedPlatformAdministratorProof(client: PoolClient, admission: string) {
  return (
    (
      await client.query<PlatformAdministratorProof>(
        `SELECT receipt, representation_id,
    representation_generation, subject_generation, principal_epoch
    FROM access.platform_administrator_admission WHERE admission_id = $1`,
        [admission],
      )
    ).rows[0] ?? null
  );
}

export async function platformAdministratorProofCurrent(
  client: PoolClient,
  saved: PlatformAdministratorProof,
  principal: string,
  actor: string,
): Promise<boolean> {
  const current = await platformAdministratorProof(client, principal, actor);
  return (
    current !== null &&
    current.receipt === saved.receipt &&
    current.representation_id === saved.representation_id &&
    current.representation_generation === saved.representation_generation &&
    current.subject_generation === saved.subject_generation &&
    current.principal_epoch === saved.principal_epoch
  );
}

export async function savePlatformAdministratorProof(
  client: PoolClient,
  admission: string,
  proof: PlatformAdministratorProof,
) {
  await client.query(
    `INSERT INTO access.platform_administrator_admission
    (admission_id, receipt, representation_id, representation_generation, subject_generation, principal_epoch)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      admission,
      proof.receipt,
      proof.representation_id,
      proof.representation_generation,
      proof.subject_generation,
      proof.principal_epoch,
    ],
  );
}

export type FirstAdministratorResult =
  | { status: 'unconfigured' }
  | { status: 'granted' | 'ignored'; receipt: string };

/** Access owner startup command. The recovery singleton serializes simultaneous
 * first boots. Role and audit receipt commit together; configuration is never
 * authority again once a designation exists, even for the same subject. */
export class AccessPlatformAdministrators {
  constructor(private readonly pool: Pool) {}
  async designateFirst(
    issuer: string,
    subject: string | undefined,
    log: (message: string) => void = console.info,
  ): Promise<FirstAdministratorResult> {
    if (!subject) return { status: 'unconfigured' };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = (
        await client.query<{ open: boolean }>(
          'SELECT open FROM access.recovery_fence WHERE id = true FOR UPDATE',
        )
      ).rows[0];
      const existing = (
        await client.query<{ receipt: string }>(
          'SELECT receipt FROM access.platform_administrator WHERE singleton LIMIT 1',
        )
      ).rows[0];
      if (existing) {
        await client.query(`SELECT access.seed_platform_grants(principal_id,receipt)
          FROM access.platform_administrator WHERE singleton`);
        await client.query('COMMIT');
        log('PLATFORM_FIRST_ADMIN_ACCOUNT ignored: a platform administrator already exists');
        return { status: 'ignored', receipt: existing.receipt };
      }
      if (!fence?.open) throw new Error('First platform administrator: Access recovery is held');
      if (!issuer || !/^[^\s\0]{1,256}$/.test(subject))
        throw new Error('Invalid PLATFORM_FIRST_ADMIN_ACCOUNT');
      const principal = (
        await client.query<{ id: string; active: boolean }>(
          'SELECT id, active FROM access.principal WHERE account_issuer = $1 AND account_subject = $2 FOR UPDATE',
          [issuer, subject],
        )
      ).rows[0];
      if (!principal?.active)
        throw new Error('First platform administrator needs an existing active Access principal');
      const digest = createHash('sha256')
        .update(JSON.stringify(['platform-first-administrator-v1', issuer, subject]))
        .digest('hex');
      const receipt = `urn:rezics:access-receipt:${digest}`;
      await client.query(
        `INSERT INTO access.platform_administrator
        (singleton,principal_id,role,receipt,request_digest,idempotency_key)
        VALUES (true,$1,'platform.administrator',$2,$3,'platform-first-administrator-v1')`,
        [principal.id, receipt, digest],
      );
      await client.query('SELECT access.seed_platform_grants($1,$2)', [principal.id, receipt]);
      await client.query('COMMIT');
      log(`Access designated the first platform administrator; audit receipt ${receipt}`);
      return { status: 'granted', receipt };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

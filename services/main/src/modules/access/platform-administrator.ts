import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { definitionCreatorAllowed } from './definition-creator.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE } from '../rating/target-context-authority.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { questionContextPattern } from '../rating/question-presentation-context.ts';
import { ratingQuestionPresentationAction } from './rating-question-presentation.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const rootActions: Record<string, string> = {
  'rating.context.create': GLOBAL_TARGET_CONTEXT_SCOPE,
  'work.create': 'work:create:root',
  'space.create': 'space:create:root',
  'semantic.change': 'semantic:create:root',
  'catalogue.verify': 'catalogue:verify:root',
  'classification.proposition.define': 'classification:define:global',
};
const resourceActions: Record<string, string[]> = {
  'media.labels.protect': ['media:protect'],
  'media.conceal.protect': ['media:protect'],
  'zone.edit': ['zone:edit'],
  'media.campaign': ['zone:edit'],
  'zone.official': ['zone:official'],
  'semantic.read': ['semantic:read'],
  'semantic.change': ['semantic:edit'],
  'lexicon.presentation.change': ['semantic:edit'],
  'lexicon.presentation.review': ['semantic:edit'],
  'rating.question-presentation.change': ['rating:presentation'],
  'rating.question-presentation.review': ['rating:presentation'],
};

/** A closed administrative vocabulary; unrelated private/member actions do not
 * inherit this role. Scope, recovery, Account and controller fences still apply. */
export function platformAdministratorAction(action: string, scope: string): boolean {
  if (Object.hasOwn(rootActions, action) && rootActions[action] === scope) return true;
  return (Object.hasOwn(resourceActions, action) ? resourceActions[action]! : []).some(
    (prefix) => scope.startsWith(`${prefix}:`) && native.test(scope.slice(prefix.length + 1)),
  );
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
  if (Object.hasOwn(rootActions, action) && rootActions[action] === scope) return true;
  if (['media.labels.protect', 'media.conceal.protect'].includes(action)) return true;
  if (!graph || !native.test(actor)) return false;
  const target = scope.slice(scope.indexOf('https://rezics.com/id/'));
  if (ratingQuestionPresentationAction(action)) {
    return (await graph.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      ${questionContextPattern(target)} FILTER(?questionOwner = ${iri(GLOBAL_RATING_POPULATION_OWNER)})
    }`, 1024)).boolean === true;
  }
  if (scope.startsWith('semantic:edit:')) {
    return definitionCreatorAllowed(client, graph, principal, actor, target);
  }
  if (action === 'semantic.read' && await definitionCreatorAllowed(client, graph, principal, actor, target)) {
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

/** One singleton role lookup and one indexed live controller lookup. The
 * designation receipt is immutable; deactivating the principal never reboots
 * the configuration into a new grant. No permission-grant fan-out. */
export async function platformAdministratorProof(
  client: Pick<PoolClient, 'query'>,
  principalId: string,
  actor: string,
  lock = true,
): Promise<PlatformAdministratorProof | null> {
  if (!native.test(actor)) return null;
  return (
    (
      await client.query<PlatformAdministratorProof>(
        `SELECT a.receipt,
      r.id AS representation_id, r.generation AS representation_generation,
      s.generation AS subject_generation, p.enforcement_epoch AS principal_epoch
    FROM access.principal p
    JOIN access.platform_administrator a ON p.id = a.principal_id AND p.active
    JOIN access.representation r ON r.principal_id = p.id
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
    WHERE a.singleton AND p.id = $1 AND r.subject_id = $2 AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp()
    ORDER BY r.id LIMIT 1${lock ? ' FOR SHARE OF p,r,s' : ''}`,
        [principalId, actor],
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
      await client.query(
        `INSERT INTO access.scope_gate (id)
        SELECT unnest($1::text[]) ON CONFLICT (id) DO NOTHING`,
        [[...Object.values(rootActions), 'governance:platform']],
      );
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

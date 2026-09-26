import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client, Pool, type PoolClient } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import {
  DECISION_LIMITS, publicDecisionResult, type DecisionSnapshotRow, type DecisionTraceEntry,
} from '../../../services/main/src/modules/access/decision-snapshot-schema.ts';
import {
  INTERACTION_KINDS, interactionScope, type InteractionBlockRow,
} from '../../../services/main/src/modules/access/interaction-schema.ts';
import {
  POLICY_CONDITION_OPS, POLICY_LIMITS, POLICY_PROFILE, type PolicyRevisionRow,
  type PolicySetAdmissionRow,
} from '../../../services/main/src/modules/access/policy-schema.ts';
import {
  REVOCATION_AFFECTED_WORK_LIMIT, type RevocationRow,
} from '../../../services/main/src/modules/access/revocation-schema.ts';

// Phase-A owner schema for the policy, interaction, decision-frame and revocation
// records (migrations 040-049). It serves IAM07, IAM15-IAM20, IAM22, IAM29 and
// IAM33, but proves storage invariants only; the owning APIs close those cases.
const root = resolve(import.meta.dir, '../../..');
const migrations = join(root, 'services/main/migrations/access');
const files = [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort();
const headFiles = files.filter(file => file < '040');
const newFiles = files.filter(file => file >= '040');
// Apply this owner's range separately, then complete the upgrade through the
// current head before comparing it with an empty install.
const ownFiles = newFiles.filter(file => /^04\d_/.test(file));
const laterFiles = newFiles.filter(file => !ownFiles.includes(file));
const iri = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

async function applyFiles(pool: Pool, names: string[]): Promise<void> {
  for (const name of names) await pool.query(readFileSync(join(migrations, name), 'utf8'));
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the original failure */ }
    throw error;
  } finally { client.release(); }
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try { await work; } catch (error) { failure = error; }
  expect((failure as { code?: string } | undefined)?.code).toBe(code);
}

async function schemaSignature(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ item: string }>(`
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' '
      || is_nullable || ' ' || coalesce(column_default, '') AS item
    FROM information_schema.columns WHERE table_schema = 'access'
    UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' '
      || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'access'::regnamespace
    UNION ALL SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'access'
    UNION ALL SELECT 'trigger ' || pg_get_triggerdef(t.oid) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relnamespace = 'access'::regnamespace
    UNION ALL SELECT 'function ' || proname || ' ' || md5(prosrc) FROM pg_proc
      WHERE pronamespace = 'access'::regnamespace
    ORDER BY 1`);
  return result.rows.map(row => row.item);
}

interface Head {
  owner: string; realm: string; member: string; outsider: string; exception: string;
  publisher: string; manager: string; reader: string; wiki: string;
  publisherRepresentation: string; publisherGrant: string; managerRepresentation: string;
  readerMandate: string; memberMembership: string; publisherMembership: string;
  outsiderGrant: string; workGrants: [string, string]; admission: string; lease: string;
}

/** Existing-head authority rows, written only through columns that exist before 040. */
async function seedHead(pool: Pool): Promise<Head> {
  const q: Query = (sql, params) => pool.query(sql, params);
  const h: Head = {
    owner: iri(), realm: iri(), member: iri(), outsider: iri(), exception: iri(),
    publisher: randomUUID(), manager: randomUUID(), reader: randomUUID(),
    wiki: `wiki:${randomUUID()}`, publisherRepresentation: randomUUID(),
    publisherGrant: randomUUID(), managerRepresentation: randomUUID(),
    readerMandate: randomUUID(), memberMembership: randomUUID(),
    publisherMembership: randomUUID(), outsiderGrant: randomUUID(),
    workGrants: [randomUUID(), randomUUID()], admission: randomUUID(), lease: randomUUID(),
  };
  const contribution = iri();
  for (const [id, name] of [[h.publisher, 'publisher'], [h.manager, 'manager'], [h.reader, 'reader']]) {
    await q(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, 'https://account.rezics.test', $2)`, [id, `${name}-${id}`]);
  }
  for (const subject of [h.owner, h.member, h.outsider, h.exception]) {
    await q("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [subject]);
  }
  await q("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')", [h.realm]);
  for (const scope of [h.wiki, 'work:create:root', `contribution:read:${contribution}`]) {
    await q('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  }
  const mandate = `INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 day')`;
  await q(mandate, [h.publisherRepresentation, h.publisher, h.owner, 'access.policy.manage']);
  await q(mandate, [h.managerRepresentation, h.manager, h.realm, 'access.policy.set-admission']);
  await q(mandate, [h.readerMandate, h.reader, h.outsider, 'work.create']);
  const grant = `INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`;
  await q(grant, [h.publisherGrant, h.owner, h.owner, h.wiki, 'access.policy.manage']);
  await q(grant, [h.outsiderGrant, h.owner, h.outsider, h.wiki, 'wiki.edit']);
  for (const id of h.workGrants) await q(grant, [id, h.owner, h.outsider, 'work:create:root', 'work.create']);
  await q(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
    VALUES ('realm', $1, 0, 'terms-1')`, [h.realm]);
  await q(`INSERT INTO access.membership (id, kind, owner_subject, member_subject, state,
      generation, policy_revision, terms_revision, consent_reference)
    VALUES ($1, 'realm', $2, $3, 'joined', 1, 0, 'terms-1', 'consent-1')`,
  [h.memberMembership, h.realm, h.member]);
  const consent = randomUUID();
  await q(`INSERT INTO access.private_membership_consent (id, principal_id, principal_epoch, kind,
      owner_subject, policy_revision, terms_revision, next_generation, expires_at)
    VALUES ($1, $2, 0, 'realm', $3, 0, 'terms-1', 1, now() + interval '5 minutes')`,
  [consent, h.publisher, h.realm]);
  await q(`INSERT INTO access.private_membership (id, kind, owner_subject, principal_id, state,
      generation, policy_revision, terms_revision, consent_reference)
    VALUES ($1, 'realm', $2, $3, 'joined', 1, 0, 'terms-1', $4)`,
  [h.publisherMembership, h.realm, h.publisher, consent]);
  await q(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state,
      represented_representation_id, represented_representation_generation,
      represented_grant_id, represented_grant_generation, represented_subject_generation,
      represented_principal_epoch)
    VALUES ($1, $2, $3, 'work:create:root', 'work.create', 'head-admission', $4, 0,
      now() + interval '1 hour', 'registered', $5, 0, $6, 0, 0, 0)`,
  [h.admission, h.reader, h.outsider, 'a'.repeat(64), h.readerMandate, h.workGrants[0]]);
  await q(`INSERT INTO access.search_read_lease (id, principal_id, acting_subject, contribution,
      scope_id, representation_id, grant_id, authority_epoch, principal_epoch,
      recovery_generation, subject_generation, representation_generation, grant_generation,
      expires_at, state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, 0, 0,
      clock_timestamp() + interval '10 seconds', 'admitted')`,
  [h.lease, h.reader, h.outsider, contribution, `contribution:read:${contribution}`,
    h.readerMandate, h.workGrants[0]]);
  return h;
}

interface RuleInput {
  tier: 'mandatory' | 'ordered'; position: number; ruleId: string;
  effect: 'require' | 'allow' | 'deny'; condition: Record<string, unknown>; actions?: string[];
}
interface Reference { ruleId: string; admission: string; polarity: 'exclude' | 'include' }

/** Publishes the next revision exactly as an owner command would, epoch first. */
async function publish(client: PoolClient, h: Head, policy: string, revision: number,
  rules: RuleInput[], references: Reference[], declared?: Partial<Record<string, number>>,
  closed?: Partial<Record<'combining' | 'profile' | 'defaultEffect', string>>) {
  const epoch = await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
    SET authority_epoch = authority_epoch + 1 WHERE id = $1 RETURNING authority_epoch`, [h.wiki]);
  if (revision === 1) {
    await client.query(`INSERT INTO access.policy (id, scope_id, owner_subject, head_revision)
      VALUES ($1, $2, $3, 1)`, [policy, h.wiki, h.owner]);
  }
  await client.query(`INSERT INTO access.policy_revision (policy_id, revision, scope_id, profile,
      combining_algorithm, default_effect, mandatory_count, ordered_count, reference_count,
      max_states, max_input_rows, deadline_ms, digest, published_by_principal,
      publisher_subject, publisher_representation_id, publisher_representation_generation,
      publisher_grant_id, publisher_grant_generation, result_authority_epoch)
    VALUES ($1, $2, $3, $4, $14, $15, $5, $6, $7, 2048, 4096, 50, $8,
      $9, $10, $11, 0, $12, 0, $13)`,
  [policy, revision, h.wiki, closed?.profile ?? POLICY_PROFILE,
    declared?.mandatory ?? rules.filter(rule => rule.tier === 'mandatory').length,
    declared?.ordered ?? rules.filter(rule => rule.tier === 'ordered').length,
    declared?.references ?? references.length, digest({ rules, references }),
    h.publisher, h.owner, h.publisherRepresentation, h.publisherGrant,
    epoch.rows[0]!.authority_epoch, closed?.combining ?? 'first-applicable',
    closed?.defaultEffect ?? 'deny']);
  for (const rule of rules) {
    await client.query(`INSERT INTO access.policy_rule
      (policy_id, revision, tier, position, rule_id, effect, actions, condition)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [policy, revision, rule.tier, rule.position,
      rule.ruleId, rule.effect, rule.actions ?? ['wiki.edit'], JSON.stringify(rule.condition)]);
  }
  for (const reference of references) {
    await client.query(`INSERT INTO access.policy_rule_set_reference
      (policy_id, revision, rule_id, set_admission_id, polarity) VALUES ($1, $2, $3, $4, $5)`,
    [policy, revision, reference.ruleId, reference.admission, reference.polarity]);
  }
  if (revision > 1) {
    await client.query('UPDATE access.policy SET head_revision = $2 WHERE id = $1', [policy, revision]);
  }
  return epoch.rows[0]!.authority_epoch;
}

let empty: Pool;
let upgrade: Pool;
let dropDatabases: () => Promise<void> = async () => undefined;
let h: Head;
const policy = randomUUID();
const rules = { guard: randomUUID(), exception: randomUUID(), principalExclusion: randomUUID(),
  actorExclusion: randomUUID(), grant: randomUUID() };
const admissions = { principal: randomUUID(), actor: randomUUID() };

beforeAll(async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  const accessUrl = Bun.env.ACCESS_DATABASE_URL;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !accessUrl) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}`
    + `@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const owner = new URL(accessUrl).username;
  const suffix = randomBytes(6).toString('hex');
  const names = [`g046_${suffix}_empty`, `g046_${suffix}_upgrade`];
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const name of names) await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
  } finally { await admin.end(); }
  [empty, upgrade] = names.map(name => {
    const url = new URL(accessUrl);
    url.pathname = `/${name}`;
    return new Pool({ connectionString: url.toString(), max: 4 });
  }) as [Pool, Pool];
  dropDatabases = async () => {
    await Promise.all([empty.end(), upgrade.end()]);
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      for (const name of names) await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally { await cleanup.end(); }
  };
  // The Access owner role, not a superuser, applies migrations as `stack:up` does.
  await applyFiles(empty, files);
  h = await seedHead(empty);
  await inTransaction(empty, async client => {
    for (const [id, basis] of [[admissions.principal, 'authenticated_principal'],
      [admissions.actor, 'acting_subject']] as const) {
      await client.query(`INSERT INTO access.policy_set_admission (id, set_kind,
          set_owner_subject, basis, referencing_scope_id, purpose, admitted_by_principal,
          admitting_representation_id, admitting_representation_generation, valid_until)
        VALUES ($1, 'realm', $2, $3, $4, 'resource-exclusion', $5, $6, 0,
          now() + interval '30 days')`,
      [id, h.realm, basis, h.wiki, h.manager, h.managerRepresentation]);
    }
    await client.query("UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1", [h.wiki]);
  });
  const principalExclusion = { op: 'member-of', admission: admissions.principal,
    basis: 'authenticated_principal' };
  await inTransaction(empty, client => publish(client, h, policy, 1, [
    { tier: 'mandatory', position: 1, ruleId: rules.guard, effect: 'require',
      condition: { op: 'authenticated' } },
    { tier: 'ordered', position: 1, ruleId: rules.exception, effect: 'allow',
      condition: { op: 'subject-is', subject: h.exception } },
    { tier: 'ordered', position: 2, ruleId: rules.principalExclusion, effect: 'deny',
      condition: principalExclusion },
    { tier: 'ordered', position: 3, ruleId: rules.grant, effect: 'allow',
      condition: { op: 'has-grant', action: 'wiki.edit' } },
  ], [{ ruleId: rules.principalExclusion, admission: admissions.principal, polarity: 'exclude' }]));
  // Revision 2 moves the Realm exclusions ahead of the exception with the same
  // stable rule IDs and adds the acting-subject mode as a separate rule.
  await inTransaction(empty, client => publish(client, h, policy, 2, [
    { tier: 'mandatory', position: 1, ruleId: rules.guard, effect: 'require',
      condition: { op: 'authenticated' } },
    { tier: 'ordered', position: 1, ruleId: rules.principalExclusion, effect: 'deny',
      condition: principalExclusion },
    { tier: 'ordered', position: 2, ruleId: rules.exception, effect: 'allow',
      condition: { op: 'subject-is', subject: h.exception } },
    { tier: 'ordered', position: 3, ruleId: rules.actorExclusion, effect: 'deny',
      condition: { op: 'any', args: [{ op: 'member-of', admission: admissions.actor,
        basis: 'acting_subject' }] }, actions: ['wiki.edit', 'wiki.read'] },
    { tier: 'ordered', position: 4, ruleId: rules.grant, effect: 'allow',
      condition: { op: 'has-grant', action: 'wiki.edit' } },
  ], [
    { ruleId: rules.principalExclusion, admission: admissions.principal, polarity: 'exclude' },
    { ruleId: rules.actorExclusion, admission: admissions.actor, polarity: 'exclude' },
  ]));
}, 60_000);

afterAll(async () => { await dropDatabases(); }, 30_000);

test('Access G-046 schema: empty install equals a pre-040 upgrade through current head', async () => {
  expect(newFiles.length).toBeGreaterThanOrEqual(4);
  expect(newFiles.filter(file => /^04\d_/.test(file))).toEqual(['040_access_policy.sql',
    '041_access_interaction.sql', '042_access_decision_snapshot.sql',
    '043_access_revocation.sql']);
  await applyFiles(upgrade, headFiles);
  const existing = await seedHead(upgrade);
  const count = async (table: string) => (await upgrade.query<{ n: string }>(
    `SELECT count(*) AS n FROM access.${table}`)).rows[0]!.n;
  const tables = ['principal', 'authority_subject', 'representation', 'permission_grant',
    'membership', 'private_membership', 'admission', 'search_read_lease'];
  const before = await Promise.all(tables.map(count));
  await applyFiles(upgrade, ownFiles);
  await applyFiles(upgrade, laterFiles);
  expect(await Promise.all(tables.map(count))).toEqual(before);
  expect(await schemaSignature(upgrade)).toEqual(await schemaSignature(empty));

  // The new records bind to rows that existed before the upgrade.
  await upgrade.query(`INSERT INTO access.policy_set_admission (id, set_kind, set_owner_subject,
      basis, referencing_scope_id, purpose, admitted_by_principal, admitting_representation_id,
      admitting_representation_generation, valid_until)
    VALUES ($1, 'realm', $2, 'acting_subject', $3, 'resource-exclusion', $4, $5, 0,
      now() + interval '1 day')`, [randomUUID(), existing.realm, existing.wiki,
    existing.manager, existing.managerRepresentation]);
  const revocation = randomUUID();
  await inTransaction(upgrade, async client => {
    await client.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [existing.workGrants[0]]);
    const epoch = await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
      SET authority_epoch = authority_epoch + 1 WHERE id = 'work:create:root'
      RETURNING authority_epoch`);
    await client.query(`INSERT INTO access.revocation (id, principal_id, issuer_subject, mode,
        target_kind, permission_grant_id, target_generation, scope_id, fence_authority_epoch,
        recovery_generation, affected_work, state)
      VALUES ($1, $2, $3, 'strong', 'permission_grant', $4, 1, 'work:create:root', $5, 0, 2,
        'draining')`, [revocation, existing.publisher, existing.owner, existing.workGrants[0],
      epoch.rows[0]!.authority_epoch]);
    await client.query(`INSERT INTO access.revocation_affected_work
      (revocation_id, ordinal, admission_id, search_read_lease_id)
      VALUES ($1, 1, $2, NULL), ($1, 2, NULL, $3)`, [revocation, existing.admission, existing.lease]);
  });
  const saved = await upgrade.query<RevocationRow>('SELECT * FROM access.revocation WHERE id = $1',
    [revocation]);
  expect(saved.rows[0]?.state).toBe('draining');
  expect(saved.rows[0]?.affected_work).toBe(2);
}, 60_000);

test('Access G-046 schema: policy revisions pin order, guards and admitted set references', async () => {
  const revisions = await empty.query<PolicyRevisionRow>(`SELECT * FROM access.policy_revision
    WHERE policy_id = $1 ORDER BY revision`, [policy]);
  expect(revisions.rows.map(row => [row.revision, row.combining_algorithm, row.default_effect,
    row.mandatory_count, row.ordered_count, row.reference_count])).toEqual([
    ['1', 'first-applicable', 'deny', 1, 3, 1], ['2', 'first-applicable', 'deny', 1, 4, 2]]);
  const order = await empty.query<{ revision: string; rule_id: string }>(`SELECT revision, rule_id
    FROM access.policy_rule WHERE policy_id = $1 AND tier = 'ordered'
    ORDER BY revision, position`, [policy]);
  expect(order.rows.map(row => row.rule_id)).toEqual([rules.exception, rules.principalExclusion,
    rules.grant, rules.principalExclusion, rules.exception, rules.actorExclusion, rules.grant]);
  expect(POLICY_CONDITION_OPS).toContain('member-of');

  const nextRules = (condition: Record<string, unknown>): RuleInput[] => [
    { tier: 'mandatory', position: 1, ruleId: rules.guard, effect: 'require',
      condition: { op: 'authenticated' } },
    { tier: 'ordered', position: 1, ruleId: rules.principalExclusion, effect: 'deny', condition }];
  const principalExclusion = { op: 'member-of', admission: admissions.principal,
    basis: 'authenticated_principal' };
  // A revision cannot commit with fewer rules than declared, skip a head, or be
  // extended after publication.
  await expectCode(inTransaction(empty, client => publish(client, h, policy, 3,
    nextRules(principalExclusion), [], { ordered: 2 })), '23514');
  await expectCode(inTransaction(empty, client => client.query(
    'UPDATE access.policy SET head_revision = 4 WHERE id = $1', [policy])), '23514');
  await expectCode(inTransaction(empty, async client => {
    await client.query(`INSERT INTO access.policy_rule (policy_id, revision, tier, position,
        rule_id, effect, actions, condition)
      VALUES ($1, 2, 'ordered', 5, $2, 'allow', ARRAY['wiki.edit'], '{"op":"authenticated"}')`,
    [policy, randomUUID()]);
  }), '23514');
  await expectCode(empty.query(`UPDATE access.policy_rule SET effect = 'allow'
    WHERE policy_id = $1 AND revision = 2 AND rule_id = $2`, [policy, rules.principalExclusion]), '23514');
  await expectCode(empty.query('DELETE FROM access.policy_revision WHERE policy_id = $1', [policy]), '23514');
  // A member-of condition without its admitted reference row cannot commit.
  await expectCode(inTransaction(empty, client => publish(client, h, policy, 3,
    nextRules(principalExclusion), [])), '23514');
  // Closed registries: one combining algorithm and default, a pinned profile,
  // explicit actions, known condition operators and require-only mandatory guards.
  for (const closed of [{ combining: 'deny-overrides' }, { defaultEffect: 'allow' },
    { profile: 'access-policy-v0' }]) {
    await expectCode(inTransaction(empty, client => publish(client, h, policy, 3,
      nextRules({ op: 'authenticated' }), [], undefined, closed)), '23514');
  }
  for (const rule of [
    { actions: ['*'], condition: { op: 'authenticated' }, effect: 'allow', tier: 'ordered' },
    { actions: ['wiki.edit'], condition: { op: 'sql', text: 'SELECT 1' }, effect: 'allow', tier: 'ordered' },
    { actions: ['wiki.edit'], condition: { op: 'authenticated', pad: 'x'.repeat(POLICY_LIMITS.conditionBytes) },
      effect: 'allow', tier: 'ordered' },
    { actions: ['wiki.edit'], condition: { op: 'authenticated' }, effect: 'allow', tier: 'mandatory' },
  ]) {
    await expectCode(inTransaction(empty, async client => {
      await client.query(`INSERT INTO access.policy_rule (policy_id, revision, tier, position,
          rule_id, effect, actions, condition) VALUES ($1, 2, $2, 9, $3, $4, $5, $6)`,
      [policy, rule.tier, randomUUID(), rule.effect, rule.actions, JSON.stringify(rule.condition)]);
    }), '23514');
  }
  // Set references must name an active admission for this scope, purpose and basis.
  const otherScope = `wiki:${randomUUID()}`;
  const foreign = randomUUID();
  const revoked = randomUUID();
  await empty.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [otherScope]);
  for (const [id, scope] of [[foreign, otherScope], [revoked, h.wiki]] as const) {
    await empty.query(`INSERT INTO access.policy_set_admission (id, set_kind, set_owner_subject,
        basis, referencing_scope_id, purpose, admitted_by_principal, admitting_representation_id,
        admitting_representation_generation, valid_until)
      VALUES ($1, 'realm', $2, 'authenticated_principal', $3, $4, $5, $6, 0, now() + interval '1 day')`,
    [id, h.realm, scope, id === revoked ? 'resource-eligibility' : 'resource-exclusion',
      h.manager, h.managerRepresentation]);
  }
  await empty.query('UPDATE access.policy_set_admission SET active = false WHERE id = $1', [revoked]);
  for (const [condition, reference] of [
    [{ op: 'member-of', admission: foreign, basis: 'authenticated_principal' },
      { admission: foreign, polarity: 'exclude' }],
    [principalExclusion, { admission: admissions.principal, polarity: 'include' }],
    [{ op: 'authenticated' }, { admission: admissions.principal, polarity: 'exclude' }],
    [{ op: 'member-of', admission: admissions.principal, basis: 'acting_subject' },
      { admission: admissions.principal, polarity: 'exclude' }],
    [{ op: 'member-of', admission: revoked, basis: 'authenticated_principal' },
      { admission: revoked, polarity: 'include' }],
  ] as const) {
    await expectCode(inTransaction(empty, client => publish(client, h, policy, 3,
      nextRules(condition), [{ ruleId: rules.principalExclusion, ...reference }])), '23514');
  }

  // Admission lifecycle: revocation advances its generation and cannot be undone.
  const admission = await empty.query<PolicySetAdmissionRow>(
    'SELECT * FROM access.policy_set_admission WHERE id = $1', [revoked]);
  expect([admission.rows[0]?.active, admission.rows[0]?.generation]).toEqual([false, '1']);
  await expectCode(empty.query('UPDATE access.policy_set_admission SET active = true WHERE id = $1',
    [revoked]), '23514');
  await expectCode(empty.query(`UPDATE access.policy_set_admission SET purpose = 'resource-eligibility'
    WHERE id = $1`, [admissions.principal]), '23514');
  await expectCode(empty.query('DELETE FROM access.policy_set_admission WHERE id = $1', [revoked]), '23514');
  await expectCode(empty.query(`INSERT INTO access.policy_set_admission (id, set_kind,
      set_owner_subject, basis, referencing_scope_id, purpose, admitted_by_principal,
      admitting_representation_id, admitting_representation_generation, valid_until)
    VALUES ($1, 'realm', $2, 'acting_subject', $3, 'resource-exclusion', $4, $5, 0,
      now() + interval '1 day')`, [randomUUID(), h.realm, h.wiki, h.manager,
    h.managerRepresentation]), '23505');
  const head = await empty.query<{ head_revision: string }>(
    'SELECT head_revision FROM access.policy WHERE id = $1', [policy]);
  expect(head.rows[0]?.head_revision).toBe('2');
}, 60_000);

test('Access G-046 schema: a decision frame comes from one snapshot and never turns unknown into allow', async () => {
  const frame = async (client: PoolClient | Pool) => (await client.query<{
    authority_epoch: string; group_generation: string; snapshot: string }>(`
    SELECT authority_epoch, group_generation, pg_current_snapshot()::text AS snapshot
    FROM access.scope_gate WHERE id = $1`, [h.wiki])).rows[0]!;
  const trace = (ordered: DecisionTraceEntry['outcome'][], mandatory: DecisionTraceEntry['outcome'] = 'pass') =>
    JSON.stringify([{ tier: 'mandatory', position: 1, outcome: mandatory },
      ...ordered.map((outcome, index) => ({ tier: 'ordered', position: index + 1, outcome }))]);
  const insert = async (client: PoolClient | Pool, values: Partial<Record<string, unknown>> & {
    actor: string; outcome: string; reason: string; tier?: string | null; position?: number | null;
    rule?: string | null; trace: string }) => {
    const current = await frame(client);
    const id = randomUUID();
    await client.query(`INSERT INTO access.decision_snapshot (id, kind, audience, principal_id,
        principal_epoch, acting_subject, acting_subject_generation, action, scope_id,
        authority_epoch, group_generation, recovery_generation, policy_id, policy_revision,
        input_snapshot, outcome, public_result, reason, deciding_tier, deciding_position,
        deciding_rule_id, rule_trace, evaluated_states, evaluated_rows, reusable, expires_at)
      VALUES ($1, 'policy', 'rezics-native-client', $2, 0, $3, 0, 'wiki.edit', $4, $5, $6, 0,
        $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 6, 9, true,
        clock_timestamp() + $17::interval)`,
    [id, values.principal ?? h.reader, values.actor, h.wiki,
      values.authorityEpoch ?? current.authority_epoch, current.group_generation, policy,
      values.revision ?? 2, current.snapshot, values.outcome,
      values.publicResult ?? publicDecisionResult(values.outcome as DecisionSnapshotRow['outcome']),
      values.reason, values.tier ?? null, values.position ?? null, values.rule ?? null,
      values.trace, values.validity ?? '2 minutes']);
    return id;
  };
  const allow = { actor: h.outsider, outcome: 'allow', reason: 'rule-allow', tier: 'ordered',
    position: 4, rule: rules.grant, trace: trace(['no-match', 'no-match', 'no-match', 'match']) };
  const decision = await inTransaction(empty, async client => {
    const id = await insert(client, allow);
    await client.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role,
        kind, observed, object_generation, private_membership_id, membership_id,
        set_admission_id, permission_grant_id, set_kind, set_owner_subject)
      VALUES ($1, 1, 'condition', 'private_membership', 'absent', NULL, NULL, NULL, NULL, NULL,
          'realm', $2),
        ($1, 2, 'condition', 'policy_set_admission', 'present', 0, NULL, NULL, $3, NULL, NULL, NULL),
        ($1, 3, 'condition', 'membership', 'absent', NULL, NULL, NULL, NULL, NULL, 'realm', $2),
        ($1, 4, 'condition', 'policy_set_admission', 'present', 0, NULL, NULL, $4, NULL, NULL, NULL),
        ($1, 5, 'proof', 'permission_grant', 'present', 0, NULL, NULL, NULL, $5, NULL, NULL)`,
    [id, h.realm, admissions.principal, admissions.actor, h.outsiderGrant]);
    return id;
  });
  const saved = await empty.query<DecisionSnapshotRow>(
    'SELECT * FROM access.decision_snapshot WHERE id = $1', [decision]);
  expect([saved.rows[0]?.public_result, saved.rows[0]?.deciding_rule_id]).toEqual(['allow', rules.grant]);
  expect(saved.rows[0]!.expires_at.getTime() - saved.rows[0]!.decided_at.getTime())
    .toBeLessThanOrEqual(DECISION_LIMITS.validityMs);

  // IAM17/IAM22: an unresolved or skipped earlier rule, a failed guard or a deny
  // rule cannot be stored as allow; indeterminate is only public `unavailable`.
  for (const invalid of [
    { ...allow, trace: trace(['unknown', 'no-match', 'no-match', 'match']) },
    { ...allow, trace: trace(['no-match', 'no-match', 'no-match', 'match'], 'unknown') },
    { ...allow, trace: JSON.stringify([{ tier: 'ordered', position: 4, outcome: 'match' }]) },
    { ...allow, trace: trace(['no-match', 'match']).replace('"position":2', '"position":4') },
    { ...allow, position: 3, rule: rules.actorExclusion, trace: trace(['no-match', 'no-match', 'match']) },
    { ...allow, trace: JSON.stringify([{ tier: 'ordered', outcome: 'match' }]) },
    { actor: h.outsider, outcome: 'indeterminate', reason: 'evidence-unavailable',
      publicResult: 'allow', trace: trace(['unknown']) },
    { actor: h.outsider, outcome: 'indeterminate', reason: 'rule-allow', trace: trace(['unknown']) },
    { ...allow, validity: '6 minutes' },
  ]) await expectCode(insert(empty, invalid), '23514');

  // IAM20: epochs and head revision must be the ones visible to this transaction.
  await expectCode(insert(empty, { ...allow, authorityEpoch: '1' }), '23514');
  await expectCode(insert(empty, { ...allow, revision: 1 }), '23514');
  // Inputs must equal the same snapshot: a present member cannot be recorded as
  // absent, and a changed generation cannot be pinned.
  const deny = await insert(empty, { actor: h.member, outcome: 'deny', reason: 'rule-deny',
    tier: 'ordered', position: 3, rule: rules.actorExclusion,
    trace: trace(['no-match', 'no-match', 'match']) });
  await empty.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind,
      observed, object_generation, membership_id, set_kind, set_owner_subject)
    VALUES ($1, 1, 'condition', 'membership', 'present', 1, $2, 'realm', $3)`,
  [deny, h.memberMembership, h.realm]);
  const publisherDecision = await insert(empty, { ...allow, principal: h.publisher });
  for (const [sql, params] of [
    [`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind, observed,
        set_kind, set_owner_subject) VALUES ($1, 2, 'condition', 'membership', 'absent', 'realm', $2)`,
      [deny, h.realm]],
    [`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind, observed,
        object_generation, permission_grant_id) VALUES ($1, 3, 'proof', 'permission_grant',
        'present', 7, $2)`, [deny, h.outsiderGrant]],
    [`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind, observed,
        object_generation, permission_grant_id) VALUES ($1, 4, 'proof', 'representation',
        'present', 0, $2)`, [deny, h.outsiderGrant]],
    [`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind, observed,
        set_kind, set_owner_subject) VALUES ($1, 65, 'condition', 'private_membership',
        'absent', 'realm', $2)`, [deny, h.realm]],
    [`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role, kind, observed,
        set_kind, set_owner_subject) VALUES ($1, 5, 'condition', 'private_membership',
        'absent', 'realm', $2)`, [publisherDecision, h.realm]],
  ] as const) await expectCode(empty.query(sql, [...params]), '23514');

  // A revoked set admission is unavailable evidence, never proof of non-membership.
  const unavailable = await inTransaction(empty, async client => {
    await client.query('UPDATE access.policy_set_admission SET active = false WHERE id = $1',
      [admissions.actor]);
    await client.query('UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1',
      [h.wiki]);
    const id = await insert(client, { actor: h.outsider, outcome: 'indeterminate',
      reason: 'set-admission-unavailable', tier: 'ordered', position: 3, rule: rules.actorExclusion,
      trace: trace(['no-match', 'no-match', 'unknown']) });
    await client.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role,
        kind, observed, object_generation, set_admission_id)
      VALUES ($1, 1, 'condition', 'policy_set_admission', 'unavailable', 1, $2)`,
    [id, admissions.actor]);
    return id;
  });
  await expectCode(empty.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal,
      role, kind, observed, object_generation, set_admission_id)
    VALUES ($1, 2, 'condition', 'policy_set_admission', 'present', 1, $2)`,
  [unavailable, admissions.actor]), '23514');
  const stored = await empty.query<DecisionSnapshotRow>(
    'SELECT public_result, reusable FROM access.decision_snapshot WHERE id = $1', [unavailable]);
  expect(stored.rows[0]?.public_result).toBe('unavailable');
  await expectCode(empty.query("UPDATE access.decision_snapshot SET reusable = false WHERE id = $1",
    [decision]), '23514');
  await expectCode(empty.query('DELETE FROM access.decision_snapshot WHERE id = $1', [decision]), '23514');
  await expectCode(empty.query('DELETE FROM access.decision_snapshot_input WHERE decision_id = $1',
    [decision]), '23514');
}, 60_000);

test('Access G-046 schema: mute, interaction block and resource policy stay separate records', async () => {
  const scope = interactionScope(h.owner);
  await empty.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  await empty.query(`INSERT INTO access.interaction_mute_preference (principal_id, target_kind,
      target, match, muted, revision) VALUES ($1, 'realm', $2, 'publishing-realm', true, $3)`,
  [h.reader, h.realm, randomUUID()]);
  await expectCode(empty.query(`INSERT INTO access.interaction_mute_preference (principal_id,
      target_kind, target, match, muted, revision) VALUES ($1, 'realm', $2, 'author', true, $3)`,
  [h.reader, h.realm, randomUUID()]), '23514');
  const block = randomUUID();
  const insertBlock = (id: string, values: Partial<Record<string, unknown>> = {}) => empty.query(`
    INSERT INTO access.interaction_block (id, recipient_subject, scope_id, target_kind,
      target_subject, set_kind, set_owner_subject, basis, interactions, set_by_principal,
      set_by_representation_id, set_by_representation_generation)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)`,
  [id, h.owner, values.scope ?? scope, values.targetKind ?? 'member-set',
    values.targetSubject ?? null, values.setKind === undefined ? 'realm' : values.setKind,
    values.setOwner === undefined ? h.realm : values.setOwner,
    values.basis === undefined ? 'acting_subject' : values.basis,
    values.interactions ?? ['message', 'reply'], h.publisher, h.publisherRepresentation]);
  await insertBlock(block);
  for (const [values, code] of [
    [{}, '23505'],
    [{ scope: h.wiki }, '23514'],
    [{ targetKind: 'agent', targetSubject: h.member }, '23514'],
    [{ targetKind: 'agent', targetSubject: h.owner, setKind: null, setOwner: null, basis: null }, '23514'],
    [{ interactions: ['message', 'view'] }, '23514'],
  ] as const) await expectCode(insertBlock(randomUUID(), values), code);
  expect(INTERACTION_KINDS).toEqual(['message', 'reply', 'mention']);

  const decide = async (actor: string, outcome: 'allow' | 'deny', membership: string | null) => {
    const current = (await empty.query<{ authority_epoch: string; snapshot: string }>(`SELECT
      authority_epoch, pg_current_snapshot()::text AS snapshot FROM access.scope_gate
      WHERE id = $1`, [scope])).rows[0]!;
    const id = randomUUID();
    await inTransaction(empty, async client => {
      await client.query(`INSERT INTO access.decision_snapshot (id, kind, audience, principal_id,
          principal_epoch, acting_subject, acting_subject_generation, action, scope_id,
          authority_epoch, group_generation, recovery_generation, recipient_subject,
          input_snapshot, outcome, public_result, reason, rule_trace, evaluated_states,
          evaluated_rows, reusable, expires_at)
        VALUES ($1, 'interaction', 'rezics-native-client', $2, 0, $3, 0, 'interaction.message',
          $4, $5, 0, 0, $6, $7, $8, $8, $9, '[]', 2, 2, false, clock_timestamp() + interval '1 minute')`,
      [id, h.reader, actor, scope, current.authority_epoch, h.owner, current.snapshot, outcome,
        outcome === 'allow' ? 'interaction-permitted' : 'interaction-blocked']);
      await client.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role,
          kind, observed, object_generation, interaction_block_id)
        VALUES ($1, 1, 'condition', 'interaction_block', 'present', 0, $2)`, [id, block]);
      await client.query(`INSERT INTO access.decision_snapshot_input (decision_id, ordinal, role,
          kind, observed, object_generation, membership_id, set_kind, set_owner_subject)
        VALUES ($1, 2, 'condition', 'membership', $2, $3, $4, 'realm', $5)`,
      [id, membership ? 'present' : 'absent', membership ? 1 : null, membership, h.realm]);
    });
    return id;
  };
  await decide(h.member, 'deny', h.memberMembership);
  await decide(h.outsider, 'allow', null);
  await expectCode(decide(h.outsider, 'allow', h.memberMembership), '23514');
  // No policy, grant or mute row is created or changed by the block decisions.
  const blocks = await empty.query<InteractionBlockRow>(
    'SELECT * FROM access.interaction_block WHERE recipient_subject = $1', [h.owner]);
  expect(blocks.rows.map(row => [row.target_kind, row.basis, row.active])).toEqual([
    ['member-set', 'acting_subject', true]]);
  await empty.query('UPDATE access.interaction_block SET active = false WHERE id = $1', [block]);
  await expectCode(empty.query('UPDATE access.interaction_block SET active = true WHERE id = $1',
    [block]), '23514');
  await insertBlock(randomUUID());
  await expectCode(empty.query(`INSERT INTO access.interaction_change_receipt (principal_id,
      idempotency_key, request_digest, action, mute_revision, block_id, result_authority_epoch)
    VALUES ($1, 'mute-1', $2, 'mute', NULL, $3, 1)`, [h.reader, 'b'.repeat(64), block]), '23514');
}, 60_000);

test('Access G-046 schema: revocation fences one source and completes only after admitted work', async () => {
  const [first, second] = h.workGrants;
  const revoke = async (client: PoolClient, grant: string) => {
    await client.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grant]);
    return (await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
      SET authority_epoch = authority_epoch + 1 WHERE id = 'work:create:root'
      RETURNING authority_epoch`)).rows[0]!.authority_epoch;
  };
  const record = (client: PoolClient | Pool, id: string, grant: string, epoch: string,
    mode: 'ordinary' | 'strong', affected: number, state = 'completed') => client.query(`
    INSERT INTO access.revocation (id, principal_id, issuer_subject, mode, target_kind,
      permission_grant_id, target_generation, scope_id, fence_authority_epoch,
      recovery_generation, affected_work, state, completed_at)
    VALUES ($1, $2, $3, $4, 'permission_grant', $5, 1, 'work:create:root', $6, 0, $7, $8,
      CASE WHEN $8 = 'completed' THEN clock_timestamp() END)`,
  [id, h.publisher, h.owner, mode, grant, epoch, affected, state]);

  // IAM29: an ordinary revocation of one independent grant leaves the other.
  const ordinary = randomUUID();
  await expectCode(inTransaction(empty, async client => {
    const epoch = (await client.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0]!;
    await record(client, randomUUID(), second, epoch.authority_epoch, 'ordinary', 0);
  }), '23514');
  await expectCode(inTransaction(empty, async client => {
    const epoch = await revoke(client, second);
    await record(client, randomUUID(), second, epoch, 'ordinary', 0, 'draining');
  }), '23514');
  await inTransaction(empty, async client => {
    const epoch = await revoke(client, second);
    await record(client, ordinary, second, epoch, 'ordinary', 0);
    await client.query(`INSERT INTO access.revocation_receipt (principal_id, idempotency_key,
        request_digest, revocation_id, result_authority_epoch) VALUES ($1, 'revoke-1', $2, $3, $4)`,
    [h.publisher, 'c'.repeat(64), ordinary, epoch]);
  });
  const grants = await empty.query<{ id: string; active: boolean; generation: string }>(
    'SELECT id, active, generation FROM access.permission_grant WHERE id = ANY($1) ORDER BY id',
    [[first, second]]);
  expect(Object.fromEntries(grants.rows.map(row => [row.id, [row.active, row.generation]])))
    .toEqual({ [first]: [true, '0'], [second]: [false, '1'] });
  await expectCode(inTransaction(empty, async client => {
    const epoch = (await client.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0]!;
    await record(client, randomUUID(), second, epoch.authority_epoch, 'ordinary', 0);
  }), '23505');

  // IAM07: the strong drain list is fixed and linked to the revoked source.
  const strong = randomUUID();
  await expectCode(inTransaction(empty, async client => {
    const epoch = await revoke(client, first);
    await record(client, strong, first, epoch, 'strong', 2, 'draining');
    await client.query(`INSERT INTO access.revocation_affected_work (revocation_id, ordinal,
      admission_id) VALUES ($1, 1, $2)`, [strong, h.admission]);
  }), '23514');
  await inTransaction(empty, async client => {
    const epoch = await revoke(client, first);
    await record(client, strong, first, epoch, 'strong', 2, 'draining');
    await client.query(`INSERT INTO access.revocation_affected_work
      (revocation_id, ordinal, admission_id, search_read_lease_id)
      VALUES ($1, 1, $2, NULL), ($1, 2, NULL, $3)`, [strong, h.admission, h.lease]);
  });
  const complete = () => empty.query(`UPDATE access.revocation SET state = 'completed',
    completed_at = clock_timestamp() WHERE id = $1`, [strong]);
  await expectCode(complete(), '23514');
  await empty.query(`UPDATE access.admission SET state = 'sealed', graph_receipt = 'receipt-1',
      graph_outcome = 'cancelled', graph_data_epoch = 'epoch-1', graph_sequence = '1',
      sealed_at = clock_timestamp() WHERE id = $1`, [h.admission]);
  await expectCode(complete(), '23514');
  await empty.query(`UPDATE access.search_read_lease SET state = 'aborted',
      finished_at = clock_timestamp() WHERE id = $1`, [h.lease]);
  await complete();
  const done = await empty.query<RevocationRow>('SELECT * FROM access.revocation WHERE id = $1', [strong]);
  expect([done.rows[0]?.state, done.rows[0]?.affected_work]).toEqual(['completed', 2]);
  expect(done.rows[0]!.affected_work).toBeLessThanOrEqual(REVOCATION_AFFECTED_WORK_LIMIT);
  await expectCode(empty.query(`UPDATE access.revocation SET state = 'draining', completed_at = NULL
    WHERE id = $1`, [strong]), '23514');
  await expectCode(empty.query('DELETE FROM access.revocation WHERE id = $1', [ordinary]), '23514');
  await expectCode(empty.query(`UPDATE access.revocation_receipt SET result_authority_epoch = 99
    WHERE revocation_id = $1`, [ordinary]), '23514');
}, 60_000);

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { AccessRealmManagement, type RealmInitializationInput } from '../src/modules/access/realm-management.ts';
import { initialRealmPolicyFacts, REALM_INITIALIZATION_COST } from '../src/modules/access/realm-initialization.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { RealmSubmissionStore } from '../src/modules/realm-submission/store.ts';
import { realmSelectionSlotIri } from '../src/modules/work/select-realm.ts';
import { RV } from '../src/modules/work/activate.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';
import { withRealmPermit } from '../src/modules/access/realm-management-policy.ts';
import { readRealmAccessSettings } from '../src/modules/access/realm-management-settings.ts';
import { RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid, RealmAdminStale, RealmAdminUnavailable } from '../src/modules/realm-admin/contract.ts';
import { realmRulesRef } from '../src/modules/governance/rules.ts';
import { spaceCreationReceiptIri } from '../src/modules/space/create.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `access-realm-initialization-${randomUUID()}`);
const data = join(state, 'pgdata');
let pool: Pool;
let started = false;

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], {
    cwd: state,
    stdio: 'pipe',
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
  // PostgreSQL's socket path cannot include the full worktree name.
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(state, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-w',
      'start',
    ],
    { cwd: state, stdio: 'pipe' },
  );
  started = true;
  pool = new Pool({
    host: '127.0.0.1',
    port,
    user: process.env.USER,
    database: 'postgres',
    max: 4,
    connectionTimeoutMillis: 1000,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}, 60_000);

test('Created open self-join Realms accept eligible member submissions immediately; review and mismatched revisions stay pending', async () => {
  for (const [mode, sameRevision, expected] of [
    ['open', true, 'accepted'], ['trusted-members', true, 'accepted'],
    ['mandatory', true, 'pending'], ['open', false, 'pending'],
  ] as const) {
    const h = await fixture();
    h.input.settings = { visibility: 'public', reviewRequired: mode === 'mandatory',
      reviewMode: mode, whoMaySubmit: 'members', selfJoin: true };
    await h.management.initializeCreated(h.principal, h.input, h.env);
    const facts = initialRealmPolicyFacts(h.input, h.space);
    const memberPrincipal = { issuer: 'https://accounts.test', subject: randomUUID() };
    const memberId = randomUUID(), member = id(), scope = `submission:submit:${h.realm}`;
    await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
      [memberId, memberPrincipal.issuer, memberPrincipal.subject]);
    await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [member]);
    // A separate, already joined member carries no founder/owner authority.
    await pool.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
      SELECT gen_random_uuid(),'realm',$1,$2,'joined',1,revision,terms_revision,'member-consent'
      FROM access.membership_policy WHERE kind='realm' AND owner_subject=$1`, [h.realm, member]);
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await pool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES (gen_random_uuid(),$1,$1,$2,'submission.submit',clock_timestamp()+interval '1 hour')`, [member, scope]);
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES (gen_random_uuid(),$1,$2,'submission.submit',clock_timestamp()+interval '1 hour')`, [memberId, member]);
    expect(await withRealmPermit(pool, memberPrincipal, member, h.realm, 'submission', async permit => permit))
      .toMatchObject({ revision: facts.revision, reviewMode: mode, member: true });
    const client = await pool.connect();
    try { expect((await readRealmAccessSettings(client, h.realm)).admission).toBe('open'); }
    finally { client.release(); }

    const candidate = { actingSubject: member, kind: 'contribution' as const, work: id(), mainVersion: id(),
      contribution: id(), publicationDecision: id(), selectedDraft: id(), correctionOf: null };
    const key = randomUUID(), selection = id();
    let adoptionReads = 0;
    const bindings = (values: Record<string, string>) => ({ results: { bindings: [Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, { type: value.startsWith('http') ? 'uri' : 'literal', value }]))] } });
    // Access and submission SQL are real. The graph-owner boundary supplies
    // launch's initial revision and successful selection/acknowledgement proofs.
    const env = { ...h.env, fuseki: { query: async (sql: string) => {
      if (sql.includes('ASK') && sql.includes('rv:restoreHold')) return { boolean: true };
      if (sql.includes('SELECT ?draft WHERE')) return bindings({ draft: candidate.selectedDraft });
      if (sql.includes('SELECT ?space ?realmRevision')) return bindings({ space: h.space,
        disclosure: `${RV}Public`, visibility: 'public', mode,
        head: sameRevision ? facts.revision : `urn:rezics:realm-policy:${randomUUID()}`,
        listing: 'listed', history: 'everything', admission: 'open' });
      if (sql.includes('SELECT ?head WHERE')) return { results: { bindings: [] } };
      if (sql.includes('?outcome') && sql.includes('?digest')) {
        const ticket = (await pool.query(`SELECT id,request_digest,authority_epoch::text FROM access.admission
          WHERE principal_id=$1 AND action='submission.submit' AND idempotency_key=$2`, [memberId, key])).rows[0]!;
        const receipt = `urn:rezics:receipt:${hash(`${ticket.id}\0${receiptFamilyFor('submission.submit')}`)}`;
        expect(sql).toContain(`<${receipt}>`);
        const terminal = { outcome: `${RV}Succeeded`, digest: ticket.request_digest, id: ticket.id,
          epoch: ticket.authority_epoch, scope, dataEpoch: h.env.lineage.dataEpoch, sequence: '2' };
        if (sql.includes('?reason')) {
          adoptionReads++;
          const operation = (await pool.query('SELECT adoption FROM access.realm_submission_operation WHERE admission_id=$1',
            [ticket.id])).rows[0]!;
          expect(operation.adoption.input.policy).toEqual({ revision: facts.revision, mode });
          return bindings({ ...terminal, work: candidate.work, main: candidate.mainVersion, realm: h.realm,
            slot: realmSelectionSlotIri(h.realm, candidate.mainVersion), contribution: candidate.contribution,
            decision: candidate.publicationDecision, draft: candidate.selectedDraft, selection, unit: id(), language: 'en' });
        }
        return bindings(terminal);
      }
      throw new Error(`Unexpected graph boundary read: ${sql}`);
    } } } as unknown as WorkActivationEnvironment;
    const access = new AccessAdmissionRegistry(pool);
    const submissions = new RealmSubmissionStore(pool, access, env);
    const result = await submissions.submit(memberPrincipal, h.realm, candidate, key);
    expect(result.submission).toMatchObject({ state: expected,
      selection: expected === 'accepted' ? selection : null });
    expect(adoptionReads).toBe(expected === 'accepted' ? 1 : 0);
    expect((await pool.query('SELECT state,graph_outcome FROM access.admission WHERE principal_id=$1 AND idempotency_key=$2',
      [memberId, key])).rows[0]).toEqual({ state: 'sealed', graph_outcome: 'succeeded' });
    expect(await submissions.submit(memberPrincipal, h.realm, candidate, key)).toEqual({ ...result, replayed: true });
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      cwd: state,
      stdio: 'pipe',
    });
});

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = () => `https://rezics.com/id/${randomUUID()}`;
const rule = { id: 'be-kind', title: { original: 'ja', labels: { ja: '親切に', ar: 'كن لطيفاً' } },
  body: { original: 'ja', labels: { ja: '読者を尊重する', ar: 'احترم القراء' } }, governanceRule: null };

async function fixture(sealed = true) {
  const principal = { issuer: 'https://accounts.test', subject: randomUUID() };
  const principalId = randomUUID(), actor = id(), realm = id(), space = id(), admissionId = randomUUID();
  const key = randomUUID(), digest = hash(key), receipt = spaceCreationReceiptIri(admissionId);
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  await pool.query("INSERT INTO access.scope_gate (id) VALUES ('space:create:root') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    SELECT gen_random_uuid(),$1,$2,action,clock_timestamp()+interval '1 hour'
    FROM unnest(ARRAY['space.create','realm.owner']) action`, [principalId, actor]);
  await pool.query(`INSERT INTO access.admission
    (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,authority_epoch,
      expires_at,state,claimed_at,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
    VALUES ($1,$2,$3,'space:create:root','space.create',$4,$5,0,clock_timestamp()+interval '1 hour',
      $7,clock_timestamp(),$6,CASE WHEN $8 THEN 'succeeded' END,CASE WHEN $8 THEN 'test-epoch' END,
      CASE WHEN $8 THEN '1' END,CASE WHEN $8 THEN clock_timestamp() END)`,
  [admissionId, principalId, actor, key, digest, sealed ? receipt : null, sealed ? 'sealed' : 'claimed', sealed]);
  const statements: { sql: string; values: unknown[]; rows: number }[] = [];
  const observedPool = { connect: async () => {
    const client = await pool.connect();
    return { query: async (sql: string, values: unknown[] = []) => {
      const result = await client.query(sql, values);
      statements.push({ sql, values, rows: result.rows.length });
      return result;
    }, release: () => client.release() };
  } } as unknown as Pool;
  let graphReads = 0, proofAvailable = true, policyAvailable = true;
  const env = { lineage: { dataEpoch: 'test-epoch', routingEpoch: 'test-routing' }, fuseki: {
    query: async (sql: string, bytes: number) => {
      graphReads++;
      // The graph boundary supplies only a successful creation proof; assert
      // that the production query binds Realm, owner, admission, receipt and digest.
      expect(sql).toContain(`<${realm}>`);
      expect(sql).toContain(`<${actor}>`);
      if (!sql.includes('SELECT ?receipt ?admission')) {
        expect(sql).toContain(`<${receipt}>`);
        expect(sql).toContain(`rv:requestDigest "${digest}"`);
        expect(sql).toContain(`rv:admissionId "${admissionId}"`);
        const facts = initialRealmPolicyFacts(input, space);
        expect(sql).toContain(facts.current.replaceAll(`<${space}>`, '?space'));
        expect(sql).toContain(facts.receipt.replaceAll(`<${space}>`, '?space'));
      }
      expect(sql).toContain('rv:restoreHold true');
      expect(sql).toContain('LIMIT 2');
      expect(bytes).toBe(REALM_INITIALIZATION_COST.graphBytes);
      return { results: { bindings: proofAvailable && (policyAvailable || sql.includes('SELECT ?receipt ?admission')) ? [{ space: { type: 'uri', value: space },
        receipt: { type: 'uri', value: receipt }, admission: { type: 'literal', value: admissionId } }] : [] } };
    },
  } } as unknown as WorkActivationEnvironment;
  const input: RealmInitializationInput = { realm, actingSubject: actor, creationKey: key,
    creationDigest: digest, policyReceipt: randomUUID(), settings: { visibility: 'private', reviewRequired: false,
      reviewMode: 'trusted-members', whoMaySubmit: 'members', selfJoin: true }, rules: [rule] };
  const management = new AccessRealmManagement(observedPool);
  const snapshot = async () => (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM access.permission_grant g WHERE scope_id LIKE '%' || $1) grants,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM access.scope_gate s WHERE id LIKE '%' || $1) gates,
    (SELECT to_jsonb(r) FROM access.realm_admin_revision r WHERE realm=$1) revision,
    (SELECT to_jsonb(b) FROM access.realm_admin_owner_bootstrap b WHERE realm=$1) bootstrap,
    (SELECT to_jsonb(s) FROM access.realm_admin_settings s WHERE realm=$1) settings,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM access.realm_admin_receipt r WHERE realm=$1) receipts,
    (SELECT to_jsonb(p) FROM access.membership_policy p WHERE kind='realm' AND owner_subject=$1) policy,
    (SELECT to_jsonb(h) FROM access.governance_rule_head h WHERE ref=$2) head,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision) FROM access.governance_rule_revision r WHERE ref=$2) rules,
    (SELECT to_jsonb(i) FROM access.realm_creation_initialization i WHERE realm=$1) initialization,
    (SELECT to_jsonb(d) FROM access.realm_policy_delivery d WHERE realm=$1) delivery,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM access.representation r WHERE principal_id=$3) representations,
    (SELECT to_jsonb(s) FROM access.authority_subject s WHERE id=$1) subject`,
  [realm, realmRulesRef(realm), principalId])).rows[0];
  return { principal, principalId, actor, realm, space, admissionId, input, env, management, statements,
    snapshot, graphReads: () => graphReads, hideProof: () => { proofAvailable = false; },
    hidePolicy: () => { policyAvailable = false; } };
}

test('Created Realm initialization is atomic, creation-bound, replayable and bounded on host PostgreSQL', async () => {
  const h = await fixture();
  const first = await h.management.initializeCreated(h.principal, h.input, h.env);
  expect(first).toEqual({ realm: h.realm, accessRevision: '1', replayed: false });
  expect(await h.management.settings(h.principal, h.realm, h.actor)).toMatchObject({ generation: '1',
    settings: { ...h.input.settings, rules: [rule] }, ruleBasis: { revision: '1' } });
  const client = await pool.connect();
  try { expect(await readRealmAccessSettings(client, h.realm)).toEqual({ visibility: 'private',
    listing: 'listed', history: 'everything', admission: 'open' }); }
  finally { client.release(); }
  const initialized = await h.snapshot();
  expect(initialized.grants).toHaveLength(REALM_INITIALIZATION_COST.founderGrants);
  expect(initialized.bootstrap).toMatchObject({ admission_id: h.admissionId, owner_subject: h.actor });
  expect(initialized.initialization.policy_receipt).toBe(h.input.policyReceipt);
  expect(initialized.delivery).toMatchObject({ receipt_id: h.input.policyReceipt, generation: 1,
    visibility: 'private', review_mode: 'trusted-members', listing: 'listed', history: 'everything',
    admission: 'open', delivered: true });
  expect(initialized.rules[0].document).toMatchObject({ public: false, rules: [rule] });
  h.statements.length = 0;
  const graphReads = h.graphReads();
  expect(await h.management.initializeCreated(h.principal, h.input, h.env)).toEqual({ ...first, replayed: true });
  expect(h.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toEqual([]);
  expect(h.graphReads()).toBe(graphReads);
  expect(await h.snapshot()).toEqual(initialized);

  // Management and the legacy enrollment API remain usable; a later settings
  // revision must not be reset by replay of initial settings.
  const changed = await h.management.changeSettings(h.principal, h.realm, {
    actingSubject: h.actor, expectedGeneration: '1', expectedRulesRevision: '1', reason: 'Close submissions',
    settings: { ...h.input.settings, visibility: 'public', reviewRequired: true,
      reviewMode: undefined, whoMaySubmit: 'closed', rules: [] },
  }, randomUUID());
  expect(changed.generation).toBe('2');
  await pool.query(`UPDATE access.permission_grant SET active=false,generation=generation+1
    WHERE scope_id=$1 AND recipient_subject=$2 AND action='realm.owner'`, [`governance:realm:${h.realm}`, h.actor]);
  const revoked = await h.snapshot();
  expect(await h.management.initializeCreated(h.principal, h.input, h.env)).toEqual({ ...first, replayed: true });
  expect(await h.snapshot()).toEqual(revoked);
  expect((await pool.query(`SELECT active FROM access.permission_grant WHERE scope_id=$1 AND action='realm.owner'`,
    [`governance:realm:${h.realm}`])).rows).toEqual([{ active: false }]);
  await expect(h.management.initializeCreated(h.principal, { ...h.input, creationDigest: hash('different') }, h.env))
    .rejects.toBeInstanceOf(RealmAdminConflict);
  await expect(h.management.initializeCreated(h.principal, { ...h.input, policyReceipt: randomUUID() }, h.env))
    .rejects.toBeInstanceOf(RealmAdminConflict);
  expect(await h.management.initializeCreated(h.principal, { ...h.input,
    settings: { ...h.input.settings, whoMaySubmit: 'closed' } }, h.env)).toEqual({ ...first, replayed: true });
  await expect(h.management.initializeCreated(h.principal, { ...h.input, realm: id() }, h.env))
    .rejects.toBeInstanceOf(RealmAdminConflict);
  expect(await h.snapshot()).toEqual(revoked);
  // Replay is independent of graph availability, representation expiry and a closed Realm gate.
  h.hideProof();
  await pool.query('UPDATE access.representation SET active=false WHERE principal_id=$1', [h.principalId]);
  await pool.query('UPDATE access.scope_gate SET open=false,dispatch_open=false WHERE id=$1', [`governance:realm:${h.realm}`]);
  h.statements.length = 0;
  expect(await h.management.initializeCreated(h.principal, h.input, h.env)).toEqual({ ...first, replayed: true });
  expect(h.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toEqual([]);

  for (const [settings, rules, message] of [
    [{ ...h.input.settings, reviewRequired: true }, [rule], 'Review mode and reviewRequired disagree'],
    [h.input.settings, [rule, rule], 'Rules need unique identities and valid localized text'],
    [h.input.settings, [{ ...rule, title: { original: 'ja', labels: { ja: ' ' } } }], 'Rules need unique identities and valid localized text'],
    [h.input.settings, Array.from({ length: 12 }, (_, n) => ({ ...rule, id: `rule-${n}`,
      body: { original: 'ja', labels: { ja: 'あ'.repeat(1000) } } })), 'Rules exceed the governance document budget'],
  ] as const) {
    const invalid = await fixture();
    const before = await invalid.snapshot();
    const refused = invalid.management.initializeCreated(invalid.principal,
      { ...invalid.input, settings, rules: [...rules] }, invalid.env);
    await expect(refused).rejects.toBeInstanceOf(RealmAdminInvalid);
    await expect(refused).rejects.toThrow(message);
    expect(await invalid.snapshot()).toEqual(before);
  }

  const denied = await fixture();
  const absent = await denied.snapshot();
  denied.hideProof();
  await expect(denied.management.initializeCreated(denied.principal, denied.input, denied.env)).rejects.toBeInstanceOf(RealmAdminDenied);
  expect(await denied.snapshot()).toEqual(absent);
  await expect(denied.management.initializeCreated(h.principal, denied.input, denied.env)).rejects.toBeInstanceOf(RealmAdminDenied);
  const missingPolicy = await fixture();
  const withoutPolicy = await missingPolicy.snapshot();
  missingPolicy.hidePolicy();
  await expect(missingPolicy.management.initializeCreated(missingPolicy.principal, missingPolicy.input, missingPolicy.env))
    .rejects.toBeInstanceOf(RealmAdminDenied);
  expect(await missingPolicy.snapshot()).toEqual(withoutPolicy);

  // Failure at the final record, after grants/settings/rules have been written,
  // rolls every row back. Retrying then completes from the same creation key.
  const interrupted = await fixture();
  const beforeFailure = await interrupted.snapshot();
  await pool.query(`CREATE FUNCTION access.fail_realm_initialization() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected initialization failure'; END $$;
    CREATE TRIGGER fail_realm_initialization BEFORE INSERT ON access.realm_creation_initialization
      FOR EACH ROW EXECUTE FUNCTION access.fail_realm_initialization()`);
  try {
    await expect(interrupted.management.initializeCreated(interrupted.principal, interrupted.input, interrupted.env))
      .rejects.toBeInstanceOf(RealmAdminUnavailable);
    expect(await interrupted.snapshot()).toEqual(beforeFailure);
  } finally {
    await pool.query('DROP TRIGGER fail_realm_initialization ON access.realm_creation_initialization; DROP FUNCTION access.fail_realm_initialization()');
  }
  expect(await interrupted.management.initializeCreated(interrupted.principal, interrupted.input, interrupted.env)).toMatchObject({ replayed: false });

  const unsealed = await fixture(false);
  expect(await unsealed.management.initializeCreated(unsealed.principal, unsealed.input, unsealed.env)).toMatchObject({ replayed: false });
  expect((await pool.query('SELECT state FROM access.admission WHERE id=$1', [unsealed.admissionId])).rows[0]!.state).toBe('claimed');

  const concurrent = await fixture();
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    concurrent.management.initializeCreated(concurrent.principal, concurrent.input, concurrent.env)));
  expect(results.filter(result => !result.replayed)).toHaveLength(1);
  expect(results.filter(result => result.replayed)).toHaveLength(3);
  expect((await concurrent.snapshot()).grants).toHaveLength(REALM_INITIALIZATION_COST.founderGrants);
  expect(concurrent.graphReads()).toBe(1);

  const legacy = await fixture();
  expect(await legacy.management.initialize(legacy.principal, legacy.realm, legacy.actor, legacy.env)).toMatchObject({ replayed: false });
  const legacyState = await legacy.snapshot();
  await expect(legacy.management.initializeCreated(legacy.principal, legacy.input, legacy.env)).rejects.toBeInstanceOf(RealmAdminStale);
  expect(await legacy.snapshot()).toEqual(legacyState);
  expect(await legacy.management.initialize(legacy.principal, legacy.realm, legacy.actor, legacy.env)).toMatchObject({ replayed: true });

  const samples: { calls: number; rows: number }[] = [];
  for (const count of [0, 64, 512]) {
    await pool.query(`INSERT INTO access.realm_admin_revision (realm,generation)
      SELECT 'https://rezics.com/id/' || gen_random_uuid(),1 FROM generate_series(1,$1)`, [count]);
    const measured = await fixture();
    await measured.management.initializeCreated(measured.principal, { ...measured.input, rules: undefined }, measured.env);
    samples.push({ calls: measured.statements.length, rows: measured.statements.reduce((sum, item) => sum + item.rows, 0) });
    expect(measured.graphReads()).toBe(REALM_INITIALIZATION_COST.graphReads);
    const lookup = measured.statements.find(({ sql }) => sql.includes("action = 'space.create' AND idempotency_key"))!;
    await pool.query('SET enable_seqscan=off');
    try {
      const plan = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON) ${lookup.sql}`, lookup.values)).rows);
      expect(plan).toContain('admission_principal_id_action_idempotency_key_key');
      expect(plan).not.toContain('Seq Scan');
    } finally { await pool.query('RESET enable_seqscan'); }
  }
  expect(samples[1]).toEqual(samples[0]);
  expect(samples[2]).toEqual(samples[0]);
  expect(samples[0]!.calls).toBeLessThanOrEqual(40);
  expect(samples[0]!.rows).toBeLessThanOrEqual(12);
}, 60_000);

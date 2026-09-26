import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync,
  readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { accessOutboxCoverage, accessStateCoverage } from '../src/modules/work/restore-lineage.ts';
import { assertPgRecoveryFrontier, PgRecoveryFrontierConflict,
  type PgRecoveryFrontier } from '../src/modules/work/pg-recovery-frontier.ts';
import { openRecoveryPayload, RecoveryEnvelopeConflict,
  type RecoveryEnvelope } from '../../account/src/recovery-envelope.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('OPS03/IAM07 partial: archived Access WAL restores a later authority fence', async () => {
  const state = join(root, '.temp', `access-pitr-${Bun.randomUUIDv7()}`);
  const manifestKey = 'ab'.repeat(32);
  const primaryData = join(state, 'primary');
  const baseBackup = join(state, 'base-backup');
  const incompleteData = join(state, 'incomplete');
  const incompleteArchive = join(state, 'incomplete-wal');
  const restoredData = join(state, 'restored');
  const walArchive = join(state, 'wal-archive');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(walArchive, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', primaryData, '-A', 'trust', '--no-instructions'], { cwd: state });
  appendFileSync(join(primaryData, 'postgresql.conf'), `\nwal_level = replica\narchive_mode = on\n` +
    `archive_command = 'test ! -e ${walArchive}/%f && cp %p ${walArchive}/%f'\n`);
  const primaryPort = await freePort();
  let primaryStarted = false;
  let incompleteStarted = false;
  let restoredStarted = false;
  let primary: Pool | undefined;
  let incomplete: Pool | undefined;
  let restored: Pool | undefined;
  const startRecovery = async (data: string, archive: string, label: string) => {
    cpSync(baseBackup, data, { recursive: true });
    rmSync(join(data, 'pg_wal'), { recursive: true });
    mkdirSync(join(data, 'pg_wal'), { mode: 0o700 });
    appendFileSync(join(data, 'postgresql.auto.conf'),
      `\narchive_mode = off\nrestore_command = 'cp ${archive}/%f %p'\n`);
    writeFileSync(join(data, 'recovery.signal'), '');
    const port = await freePort();
    execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${label}.log`),
      '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    if (label === 'incomplete') incompleteStarted = true;
    else restoredStarted = true;
    const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    let recovering = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      recovering = (await pool.query<{ recovering: boolean }>('SELECT pg_is_in_recovery() AS recovering'))
        .rows[0]?.recovering ?? true;
      if (!recovering) break;
      await Bun.sleep(100);
    }
    expect(recovering).toBe(false);
    return pool;
  };
  try {
    execFileSync('pg_ctl', ['-D', primaryData, '-l', join(state, 'primary.log'),
      '-o', `-h 127.0.0.1 -p ${primaryPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    primaryStarted = true;
    primary = new Pool({ host: '127.0.0.1', port: primaryPort, user: process.env.USER,
      database: 'postgres' });
    const migrations = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort()) {
      await primary.query(readFileSync(join(migrations, file), 'utf8'));
    }
    const principalId = Bun.randomUUIDv7();
    const actingSubject = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const principal = { issuer: 'https://account.pitr.test', subject: 'pitr-user' };
    const request = { principal, actingSubject, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: 'before-backup',
      requestDigest: createHash('sha256').update('before-backup').digest('hex') };
    await primary.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await primary.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root')");
    await primary.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actingSubject]);
    await primary.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actingSubject]);
    await primary.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, 'work:create:root', 'work.create', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actingSubject]);
    const registry = new AccessAdmissionRegistry(primary);
    const admitted = await registry.register(request);
    expect(admitted.authorityEpoch).toBe('0');

    execFileSync('pg_basebackup', ['-D', baseBackup, '-Fp', '-Xs', '--checkpoint=fast',
      '-h', '127.0.0.1', '-p', String(primaryPort), '-U', process.env.USER ?? 'edge'], { cwd: state });
    // This local PostgreSQL package omits pg_waldump; WAL replay is checked below.
    execFileSync('pg_verifybackup', ['--no-parse-wal', baseBackup], { cwd: state });
    // Consent and one-use evidence must survive the isolated Access restore.
    const consentId = Bun.randomUUIDv7();
    const membershipId = Bun.randomUUIDv7();
    const consentRepresentationId = Bun.randomUUIDv7();
    const consentGrantId = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision)
      VALUES ('org',$1,1,'pitr-terms')`, [actingSubject]);
    await primary.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'access.membership.consent',now() + interval '1 hour')`,
    [consentRepresentationId, principalId, actingSubject]);
    await primary.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','access.membership.consent',now() + interval '1 hour')`,
    [consentGrantId, actingSubject]);
    await primary.query(`INSERT INTO access.membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, member_subject,
        member_generation, policy_revision, terms_revision, next_generation,
        representation_id, representation_generation, grant_id, grant_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,$3,0,1,'pitr-terms',1,$4,0,$5,0,now() + interval '5 minutes')`,
    [consentId, principalId, actingSubject, consentRepresentationId, consentGrantId]);
    await primary.query(`INSERT INTO access.membership
      (id, kind, owner_subject, member_subject, state, generation,
        policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$2,'joined',1,1,'pitr-terms',$3)`,
    [membershipId, actingSubject, consentId]);
    await primary.query(`INSERT INTO access.membership_history
      (membership_id, generation, state, policy_revision, terms_revision,
        consent_reference, changed_by_principal)
      VALUES ($1,1,'joined',1,'pitr-terms',$2,$3)`,
    [membershipId, consentId, principalId]);
    await primary.query(`INSERT INTO access.membership_consent_use
      (consent_id, membership_id, generation) VALUES ($1,$2,1)`,
    [consentId, membershipId]);
    const privateConsentId = Bun.randomUUIDv7();
    const privateMembershipId = Bun.randomUUIDv7();
    const privateGrantId = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
        terms_revision, next_generation, expires_at)
      VALUES ($1,$2,0,'org',$3,1,'pitr-terms',1,now() + interval '5 minutes')`,
    [privateConsentId, principalId, actingSubject]);
    await primary.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation,
        policy_revision, terms_revision, consent_reference)
      VALUES ($1,'org',$2,$3,'joined',1,1,'pitr-terms',$4)`,
    [privateMembershipId, actingSubject, principalId, privateConsentId]);
    await primary.query(`INSERT INTO access.private_membership_history
      (membership_id, generation, state, policy_revision, terms_revision,
        consent_reference, changed_by_principal)
      VALUES ($1,1,'joined',1,'pitr-terms',$2,$3)`,
    [privateMembershipId, privateConsentId, principalId]);
    await primary.query(`INSERT INTO access.private_membership_consent_use
      (consent_id, membership_id, generation) VALUES ($1,$2,1)`,
    [privateConsentId, privateMembershipId]);
    await primary.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until,
        private_membership_id, private_membership_generation)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour',$4,1)`,
    [privateGrantId, actingSubject, principalId, privateMembershipId]);
    const groupId = Bun.randomUUIDv7(), groupGrantId = Bun.randomUUIDv7();
    const privateGroupMemberId = Bun.randomUUIDv7(), privateRoleBindingId = Bun.randomUUIDv7();
    const roleFamilyId = Bun.randomUUIDv7();
    await primary.query(`INSERT INTO access.recipient_group (id, scope_id)
      VALUES ($1,'work:create:root')`, [groupId]);
    await primary.query(`INSERT INTO access.group_permission_grant
      (id, group_id, issuer_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour')`,
    [groupGrantId, groupId, actingSubject]);
    await primary.query(`INSERT INTO access.private_group_member
      (id, group_id, principal_id, private_membership_id,
        private_membership_generation, assigned_by_principal)
      VALUES ($1,$2,$3,$4,1,$3)`,
    [privateGroupMemberId, groupId, principalId, privateMembershipId]);
    const roleFixture = await primary.connect();
    try {
      await roleFixture.query('BEGIN');
      await roleFixture.query(`INSERT INTO access.role_family
        (id, owner_subject, scope_id, head_revision)
        VALUES ($1,$2,'work:create:root',1)`, [roleFamilyId, actingSubject]);
      await roleFixture.query(`INSERT INTO access.role_revision
        (family_id, revision, permissions) VALUES ($1,1,ARRAY['work.create']::text[])`,
      [roleFamilyId]);
      await roleFixture.query('COMMIT');
    } catch (error) { await roleFixture.query('ROLLBACK'); throw error; }
    finally { roleFixture.release(); }
    await primary.query(`INSERT INTO access.private_role_binding
      (id, family_id, role_revision, issuer_subject, principal_id,
        private_membership_id, private_membership_generation, valid_until,
        assigned_by_principal)
      VALUES ($1,$2,1,$3,$4,$5,1,now() + interval '1 hour',$4)`,
    [privateRoleBindingId, roleFamilyId, actingSubject, principalId, privateMembershipId]);
    const closure = await registry.strongCloseScope('work:create:root', '0');
    expect(closure.authorityEpoch).toBe('1');
    expect(closure.pending).toBe(1);
    const principalFence = await registry.strongDeactivatePrincipal(principalId, '0');
    expect(principalFence.enforcementEpoch).toBe('1');
    const sourceOutbox = await accessOutboxCoverage(primary);
    const sourceState = await accessStateCoverage(primary);
    const frontierCommand = join(root, 'services/main/src/pg-recovery-frontier.ts');
    const primaryUrl = `postgres://127.0.0.1:${primaryPort}/postgres?user=${process.env.USER}`;
    const captured = execFileSync(process.execPath, [frontierCommand, 'capture'], {
      cwd: root, env: { ...process.env, PG_RECOVERY_DATABASE_URL: primaryUrl }, encoding: 'utf8' });
    const frontier = JSON.parse(captured) as PgRecoveryFrontier;
    expect(frontier.systemIdentifier).toMatch(/^[0-9]+$/);
    const frontierFile = join(state, 'frontier.json');
    writeFileSync(frontierFile, JSON.stringify(frontier));
    const manifestCommand = join(root, 'services/main/src/access-recovery-manifest.ts');
    const sealed = execFileSync(process.execPath, [manifestCommand, 'capture'], {
      cwd: root, env: { ...process.env, ACCESS_RECOVERY_DATABASE_URL: primaryUrl,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, encoding: 'utf8' });
    const manifest = openRecoveryPayload<{ pg: PgRecoveryFrontier;
      outbox: typeof sourceOutbox; state: typeof sourceState }>(
      sealed, manifestKey, 'access-recovery-manifest');
    expect(manifest.outbox).toEqual(sourceOutbox);
    expect(manifest.state).toEqual(sourceState);
    const envelope = JSON.parse(sealed) as RecoveryEnvelope;
    expect(() => openRecoveryPayload(JSON.stringify({ ...envelope,
      payload: `A${envelope.payload.slice(1)}`,
    }), manifestKey, 'access-recovery-manifest')).toThrow(RecoveryEnvelopeConflict);
    expect(() => openRecoveryPayload(sealed, 'cd'.repeat(32),
      'access-recovery-manifest')).toThrow(RecoveryEnvelopeConflict);
    const manifestFile = join(state, 'access-manifest.json');
    writeFileSync(manifestFile, sealed);
    const requiredWal = frontier.walFile;
    await primary.query('SELECT pg_switch_wal()');
    for (let attempt = 0; attempt < 120 && !existsSync(join(walArchive, requiredWal)); attempt++) {
      await Bun.sleep(100);
    }
    expect(existsSync(join(walArchive, requiredWal))).toBe(true);
    await primary.end();
    primary = undefined;
    execFileSync('pg_ctl', ['-D', primaryData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    primaryStarted = false;

    mkdirSync(incompleteArchive, { mode: 0o700 });
    for (const file of readdirSync(walArchive)) {
      if (file < requiredWal) copyFileSync(join(walArchive, file), join(incompleteArchive, file));
    }
    incomplete = await startRecovery(incompleteData, incompleteArchive, 'incomplete');
    const incompleteGate = await incomplete.query<{
      authority_epoch: string; open: boolean; dispatch_open: boolean }>(
      "SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root'");
    expect(incompleteGate.rows[0]).toEqual({ authority_epoch: '0', open: true, dispatch_open: true });
    expect((await incomplete.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(true);
    expect(await accessOutboxCoverage(incomplete)).not.toEqual(sourceOutbox);
    expect(await accessStateCoverage(incomplete)).not.toEqual(sourceState);
    await expect(assertPgRecoveryFrontier(incomplete, frontier))
      .rejects.toBeInstanceOf(PgRecoveryFrontierConflict);
    const incompletePort = (await incomplete.query<{ port: string }>('SHOW port')).rows[0]!.port;
    expect(() => execFileSync(process.execPath, [frontierCommand, 'verify', frontierFile], {
      cwd: root, env: { ...process.env,
        PG_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${incompletePort}/postgres?user=${process.env.USER}` },
      stdio: 'pipe',
    })).toThrow();
    expect(() => execFileSync(process.execPath, [manifestCommand, 'verify', manifestFile], {
      cwd: root, env: { ...process.env,
        ACCESS_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${incompletePort}/postgres?user=${process.env.USER}`,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, stdio: 'pipe',
    })).toThrow();
    await incomplete.end();
    incomplete = undefined;
    execFileSync('pg_ctl', ['-D', incompleteData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    incompleteStarted = false;

    restored = await startRecovery(restoredData, walArchive, 'restored');
    const gate = await restored.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
      "SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root'");
    expect(gate.rows[0]).toEqual({ authority_epoch: '1', open: false, dispatch_open: false });
    expect((await restored.query<{ active: boolean }>(
      'SELECT active FROM access.principal WHERE id = $1', [principalId])).rows[0]?.active).toBe(false);
    expect((await restored.query<{ generation: string }>(`
      SELECT generation FROM access.membership_consent_use WHERE consent_id = $1`,
    [consentId])).rows[0]?.generation).toBe('1');
    expect((await restored.query<{ generation: string }>(`
      SELECT generation FROM access.private_membership_consent_use WHERE consent_id = $1`,
    [privateConsentId])).rows[0]?.generation).toBe('1');
    expect((await restored.query<{ private_membership_generation: string }>(`
      SELECT private_membership_generation FROM access.principal_permission_grant WHERE id = $1`,
    [privateGrantId])).rows[0]?.private_membership_generation).toBe('1');
    expect((await restored.query<{ private_membership_generation: string }>(`
      SELECT private_membership_generation FROM access.private_group_member WHERE id = $1`,
    [privateGroupMemberId])).rows[0]?.private_membership_generation).toBe('1');
    expect((await restored.query<{ private_membership_generation: string; role_revision: string }>(`
      SELECT private_membership_generation, role_revision
      FROM access.private_role_binding WHERE id = $1`,
    [privateRoleBindingId])).rows[0]).toMatchObject({
      private_membership_generation: '1', role_revision: '1' });
    expect(await accessOutboxCoverage(restored)).toEqual(sourceOutbox);
    expect(await accessStateCoverage(restored)).toEqual(sourceState);
    await expect(assertPgRecoveryFrontier(restored, frontier)).resolves.toBeUndefined();
    const restoredPort = (await restored.query<{ port: string }>('SHOW port')).rows[0]!.port;
    expect(execFileSync(process.execPath, [frontierCommand, 'verify', frontierFile], {
      cwd: root, env: { ...process.env,
        PG_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${restoredPort}/postgres?user=${process.env.USER}` },
      encoding: 'utf8',
    })).toContain('reached retained WAL frontier');
    expect(execFileSync(process.execPath, [manifestCommand, 'verify', manifestFile], {
      cwd: root, env: { ...process.env,
        ACCESS_RECOVERY_DATABASE_URL: `postgres://127.0.0.1:${restoredPort}/postgres?user=${process.env.USER}`,
        RECOVERY_MANIFEST_HMAC_KEY: manifestKey }, encoding: 'utf8',
    })).toContain('matches retained WAL and row coverage');
    const recovered = new AccessAdmissionRegistry(restored);
    await expect(recovered.claim(admitted.id, request.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(recovered.register({ ...request, idempotencyKey: 'after-recovery' }))
      .rejects.toBeInstanceOf(AdmissionDenied);
  } finally {
    await restored?.end();
    if (restoredStarted) execFileSync('pg_ctl', ['-D', restoredData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await incomplete?.end();
    if (incompleteStarted) execFileSync('pg_ctl', ['-D', incompleteData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    await primary?.end();
    if (primaryStarted) execFileSync('pg_ctl', ['-D', primaryData, '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);

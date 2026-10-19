// sql-relations-allow: public.rezics_qa_history_transition -- Explicit verified QA adoption creates this metadata; ordinary startup never does.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Client } from 'pg';
import { ensureFixtureScopeGate } from '../../services/main/src/modules/access/fixture-authority.ts';
import { replacePrivate } from '../dev/config.ts';
import { applySqlMigration, sqlMigration } from '../lib/concurrent-index.ts';
import { loadCompatibility } from '../load/compatibility.ts';
import { migrateTracked, migrationDirectories, migrationRecords, repositoryRoot } from '../ops/migrate.ts';
import { retainedBookRecipeSource, retainedQaSource, transitionQaHistory, verifyQaHistoryManifest,
  verifyQaHistoryMigrations, type QaHistoryOptions } from './history-transition.ts';
import { preserveReapEnvironment } from './container-reaper.ts';

for (const { label, source, compatibilityDigest, accessCount } of [
  { label: 'QAHISTORY01: original retained QA', source: retainedQaSource, accessCount: 299,
    compatibilityDigest: '79c3488519b38ec7f919d85713c4027c4226fc582f4afb19f1f4a7d2f1b1b056' },
  { label: 'QAHISTORY02: retained Book/Recipe', source: retainedBookRecipeSource, accessCount: 303,
    compatibilityDigest: 'eac0b47cf9ddb55c380ef50a880c1a98917d786b67f11dea26f6743670e54b82' },
]) describe(label, () => {
  const project = `rezics-qa-history-${randomUUID().slice(0, 12)}`;
  const container = `${project}-postgres-1`;
  const volume = `${project}_postgres_data`;
  const stack = join(repositoryRoot, '.temp/stack', project);
  const image = 'postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722';
  const password = randomUUID();
  let directory: string;
  let sourceRoot: string;
  let admin: Client;
  let port: string;
  let options: QaHistoryOptions;
  let backupBytes: Buffer;
  let started = false;
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

  function docker(args: string[]): string {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      env: preserveReapEnvironment(process.env) });
    if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  function ownerUrl(owner: 'access' | 'relay', database: string = owner): string {
    return `postgres://${owner}:${password}@127.0.0.1:${port}/${database}`;
  }

  async function query(database: 'access' | 'relay' | 'access_tpl' | 'relay_tpl', sql: string, values?: unknown[]) {
    const owner = database.startsWith('access') ? 'access' : 'relay';
    const client = new Client({ connectionString: ownerUrl(owner, database) });
    await client.connect();
    try { return await client.query(sql, values); }
    finally { await client.end(); }
  }

  function dump(database: 'access' | 'relay'): string {
    return docker(['exec', '--user', 'postgres', container, 'pg_dump', '--username=postgres',
      `--dbname=${database}`, '--exclude-table=public.rezics_local_migration',
      '--exclude-table=public.rezics_qa_history_transition']).replace(/^\\(?:un)?restrict .+$/gm, '');
  }

  async function expectUntracked(): Promise<void> {
    for (const owner of ['access', 'relay'] as const) {
      const result = await query(owner, `SELECT to_regclass('public.rezics_local_migration') AS history,
        to_regclass('public.rezics_qa_history_transition') AS transition`);
      expect(result.rows[0]).toEqual({ history: null, transition: null });
    }
  }

  beforeAll(async () => {
    mkdirSync(join(repositoryRoot, '.temp'), { recursive: true });
    directory = mkdtempSync(join(repositoryRoot, '.temp/qa-history-test-'));
    sourceRoot = join(directory, 'source');
    mkdirSync(sourceRoot);
    const archive = spawnSync('git', ['archive', '--format=tar', source,
      ...Object.values(migrationDirectories), 'generated/model/manifest.json', 'infra/dev/compose.yaml',
      'infra/jena/fuseki-text.ttl', 'infra/jena/fuseki-text-qa.ttl', 'services/account/package.json'],
    { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 });
    expect(archive.status).toBe(0);
    expect(spawnSync('tar', ['-x', '-C', sourceRoot], { input: archive.stdout }).status).toBe(0);
    const compatibility = loadCompatibility(sourceRoot);
    expect(compatibility.digest).toBe(compatibilityDigest);
    // An empty, isolated history-test fixture, never a receipt for either retained
    // producer corpus. Actual retained manifests are inspected independently.
    backupBytes = Buffer.from(JSON.stringify({
      format: 'command-catalogue-backup-v1', project: `rezics-catalogue-corpus-history-test-${compatibility.digest.slice(0, 16)}`,
      runId: 'history-source', compatibility,
    }));
    const backup = join(directory, 'backup.json');
    writeFileSync(backup, backupBytes);
    options = { stackDirectory: stack, backup, backupSha256: digest(backupBytes), source };
    docker(['volume', 'create', volume]);
    docker(['run', '--detach', '--name', container,
      '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=postgres',
      '--mount', `type=volume,source=${volume},destination=/var/lib/postgresql`,
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_INITDB_ARGS=--locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8',
      '-p', '127.0.0.1::5432', image]);
    started = true;
    port = docker(['port', container, '5432/tcp']).split(':').at(-1)!;
    admin = new Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 1000 });
    const deadline = Date.now() + 60_000;
    while (true) {
      try { await admin.connect(); break; }
      catch (error) {
        if (Date.now() > deadline) throw error;
        admin = new Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 1000 });
        await Bun.sleep(100);
      }
    }
    mkdirSync(stack, { recursive: true });
    replacePrivate(join(stack, 'compose.env'), { POSTGRES_PORT: port, POSTGRES_PASSWORD: password, REZICS_STACK_STORAGE: 'persistent' });
    replacePrivate(join(stack, 'apps.env'), { ACCESS_DATABASE_URL: ownerUrl('access'), ACCOUNT_RELAY_DATABASE_URL: ownerUrl('relay') });
    for (const owner of ['access', 'relay'] as const) {
      await admin.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE DATABASE ${owner} OWNER ${owner}`);
      const db = new Client({ connectionString: ownerUrl(owner) });
      await db.connect();
      try {
        // This is the exact historical untracked QA path, not the repaired helper.
        for (const file of migrationRecords(sourceRoot, owner))
          await applySqlMigration(db, sqlMigration(readFileSync(join(sourceRoot, file.name), 'utf8'), file.name));
      } finally { await db.end(); }
      await admin.query(`CREATE DATABASE ${owner}_tpl TEMPLATE ${owner} OWNER ${owner}`);
    }
  }, 180_000);

  beforeEach(async () => {
    for (const owner of ['access', 'relay']) {
      await admin.query(`DROP DATABASE ${owner} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${owner} TEMPLATE ${owner}_tpl OWNER ${owner}`);
    }
  });

  afterAll(async () => {
    if (!directory) return; // A source excluded by the owner case filter allocated nothing.
    await admin?.end();
    try { if (started) docker(['rm', '--force', '--volumes', container]); }
    finally {
      docker(['volume', 'rm', volume]);
      rmSync(stack, { recursive: true, force: true });
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });

  test('retained lineage requires both independently recorded bytes and every pinned migration byte', async () => {
    const compatibility = loadCompatibility(sourceRoot);
    expect(verifyQaHistoryManifest(backupBytes, options.backupSha256, compatibility, source).runId).toBe('history-source');
    expect(() => verifyQaHistoryManifest(backupBytes, '0'.repeat(64), compatibility)).toThrow('independently recorded SHA-256');
    for (const change of ['missing', 'drift', 'extra']) {
      const altered = JSON.parse(backupBytes.toString()) as { compatibility: { files: Record<string, string> } };
      const path = migrationRecords(sourceRoot, 'access')[0]!.name;
      if (change === 'missing') delete altered.compatibility.files[path];
      if (change === 'drift') altered.compatibility.files[path] = '0'.repeat(64);
      if (change === 'extra') altered.compatibility.files['services/main/migrations/access/99999_unknown.sql'] = '0'.repeat(64);
      const bytes = Buffer.from(JSON.stringify(altered));
      expect(() => verifyQaHistoryManifest(bytes, digest(bytes), compatibility)).toThrow('complete unchanged');
    }
    await expect(transitionQaHistory({ ...options, source: '0'.repeat(40), adopt: true })).rejects.toThrow('Unsupported QA history source');
    if (source === retainedBookRecipeSource)
      await expect(transitionQaHistory({ ...options, source: retainedQaSource, adopt: true })).rejects.toThrow('complete unchanged');
    await expectUntracked();
  });

  if (source === retainedBookRecipeSource) test('canonical receipt names require each exact inspected old and new SQL identity', async () => {
    const history = verifyQaHistoryMigrations(source, sourceRoot, 'access');
    expect(history.migrations).toHaveLength(303);
    expect(history.renames).toHaveLength(3);
    for (const rename of history.renames) {
      expect(history.sourceMigrations).toContain(rename.source);
      expect(history.migrations).toContain(rename.current);
      expect(history.migrations).not.toContain(rename.source);
      expect(digest(readFileSync(join(sourceRoot, rename.source)))).toBe(rename.sha256);
      expect(digest(readFileSync(join(repositoryRoot, rename.current)))).toBe(rename.sha256);
    }
    const currentRoot = join(directory, 'changed-current');
    const changedSource = join(directory, 'changed-source');
    cpSync(join(repositoryRoot, migrationDirectories.access), join(currentRoot, migrationDirectories.access), { recursive: true });
    cpSync(join(sourceRoot, migrationDirectories.access), join(changedSource, migrationDirectories.access), { recursive: true });
    for (const rename of history.renames) {
      const canonical = join(currentRoot, rename.current);
      const original = readFileSync(canonical);
      writeFileSync(canonical, `${original.toString()}\n-- changed SQL\n`);
      expect(() => verifyQaHistoryMigrations(source, sourceRoot, 'access', currentRoot)).toThrow('unchanged historical SQL identity');
      rmSync(canonical);
      expect(() => verifyQaHistoryMigrations(source, sourceRoot, 'access', currentRoot)).toThrow('unchanged historical SQL identity');
      writeFileSync(canonical, original);
      const historical = join(changedSource, rename.source);
      const oldBytes = readFileSync(historical);
      writeFileSync(historical, `${oldBytes.toString()}\n-- changed historical SQL\n`);
      expect(() => verifyQaHistoryMigrations(source, changedSource, 'access')).toThrow('unchanged historical SQL identity');
      rmSync(historical);
      expect(() => verifyQaHistoryMigrations(source, changedSource, 'access')).toThrow('historical filename transitions');
      writeFileSync(historical, oldBytes);
    }
    // Canonical names in a manifest cannot stand in for its historical inventory.
    const altered = JSON.parse(backupBytes.toString());
    for (const rename of history.renames) {
      delete altered.compatibility.files[rename.source];
      altered.compatibility.files[rename.current] = rename.sha256;
    }
    const bytes = Buffer.from(JSON.stringify(altered));
    expect(() => verifyQaHistoryManifest(bytes, digest(bytes), loadCompatibility(sourceRoot), source)).toThrow('complete unchanged');
    const originalStack = join(repositoryRoot, '.temp/stack/rezics-qa-history-source');
    mkdirSync(originalStack);
    try {
      await expect(transitionQaHistory({ ...options, stackDirectory: originalStack, adopt: true }))
        .rejects.toThrow('distinct disposable restored QA project');
    } finally { rmSync(originalStack, { recursive: true, force: true }); }
    await expectUntracked();
  });

  test('partial or unknown historical receipts are refused without adopting the other owner', async () => {
    await query('access', `CREATE TABLE public.rezics_local_migration(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO public.rezics_local_migration(name) VALUES ('services/main/migrations/access/001_admission.sql')`);
    await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('Unknown or partial access migration history');
    expect((await query('access', 'SELECT count(*)::int AS count FROM public.rezics_local_migration')).rows[0].count).toBe(1);
    expect((await query('relay', "SELECT to_regclass('public.rezics_local_migration') AS history")).rows[0].history).toBeNull();
  });

  test('an existing schema with a missing migration effect cannot gain receipts', async () => {
    await query('access', 'DROP INDEX access.discovery_source_key_revision');
    await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('Drifted access schema');
    await expectUntracked();
  });

  test('a populated owner missing a seeded data-only effect cannot gain receipts', async () => {
    await query('access', "DELETE FROM access.alias_reserved_word WHERE word='following'");
    await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('baseline data effect: access.alias_reserved_word');
    await expectUntracked();
  });

  test('a template with matching object counts is checked against the actual pinned SQL effects', async () => {
    try {
      for (const db of ['access', 'access_tpl'] as const)
        await query(db, "UPDATE access.alias_reserved_word SET titles=true WHERE word='following'");
      await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('frozen bootstrap data effects');
      await expectUntracked();
    } finally {
      await query('access_tpl', "UPDATE access.alias_reserved_word SET titles=false WHERE word='following'");
    }
  }, 180_000);

  test('a failed receipt write rolls back both verified owners without changing application state', async () => {
    await query('relay', `CREATE TABLE public.rezics_local_migration (
      name text PRIMARY KEY CHECK (name <> 'services/main/migrations/relay/001_delivery.sql'),
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const before = { access: digest(dump('access')), relay: digest(dump('relay')) };
    await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('check constraint');
    expect({ access: digest(dump('access')), relay: digest(dump('relay')) }).toEqual(before);
    expect((await query('access', "SELECT to_regclass('public.rezics_local_migration') AS history")).rows[0].history).toBeNull();
    expect((await query('relay', 'SELECT count(*)::int AS count FROM public.rezics_local_migration')).rows[0].count).toBe(0);
    for (const owner of ['access', 'relay'] as const)
      expect((await query(owner, "SELECT to_regclass('public.rezics_qa_history_transition') AS transition")).rows[0].transition).toBeNull();
  }, 180_000);

  test('verification is read-only and adoption preserves all owner schema, data, identities and rights', async () => {
    await query('access', `INSERT INTO access.principal(id,account_issuer,account_subject,active,enforcement_epoch)
      VALUES ('71d7f024-d173-4f6d-ae9f-83eb2115f028','https://example.test/accounts','retained-subject',false,7);
      UPDATE access.editorial_event_clock SET sequence=19 WHERE id`);
    const authority = new Client({ connectionString: ownerUrl('access') });
    await authority.connect();
    try { await ensureFixtureScopeGate(authority, 'governance:platform', { open: false }); }
    finally { await authority.end(); }
    const before = { access: digest(dump('access')), relay: digest(dump('relay')) };
    const verification = await transitionQaHistory(options);
    expect(verification.owners.access.status).toBe('verified');
    expect(verification.owners.access.migrations).toHaveLength(accessCount);
    expect(verification.owners.relay.migrations).toHaveLength(23);
    await expectUntracked();
    expect({ access: digest(dump('access')), relay: digest(dump('relay')) }).toEqual(before);
    const adopted = await transitionQaHistory({ ...options, adopt: true });
    expect(adopted.owners.access.status).toBe('adopted');
    expect(adopted.owners.relay.status).toBe('adopted');
    expect({ access: digest(dump('access')), relay: digest(dump('relay')) }).toEqual(before);
    for (const owner of ['access', 'relay'] as const) {
      expect((await query(owner, 'SELECT count(*)::int AS count FROM public.rezics_local_migration')).rows[0].count)
        .toBe(adopted.owners[owner].migrations.length);
      expect(await migrateTracked(ownerUrl(owner), repositoryRoot, migrationDirectories[owner],
        adopted.owners[owner].migrations.map(name => basename(name)))).toEqual([]);
    }
    if (source === retainedBookRecipeSource) {
      expect(adopted.owners.access.lineage?.renames).toHaveLength(3);
      expect(adopted.owners.relay.lineage?.renames).toEqual([]);
      const saved = adopted.owners.access;
      const lineage = saved.lineage!;
      for (const conflicting of [
        { ...saved, lineage: undefined },
        { ...saved, lineage: { ...lineage, backupProject: 'wrong-backup' } },
        { ...saved, lineage: { ...lineage, restoredProject: 'wrong-copy' } },
        { ...saved, lineage: { ...lineage, sourceMigrations: lineage.sourceMigrations.slice(1) } },
        { ...saved, lineage: { ...lineage, renames: lineage.renames.map(rename => ({ ...rename, sha256: '0'.repeat(64) })) } },
      ]) {
        await query('access', 'UPDATE public.rezics_qa_history_transition SET receipt=$1::jsonb', [JSON.stringify(conflicting)]);
        await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('Unknown or partial access transition history');
      }
      await query('access', 'UPDATE public.rezics_qa_history_transition SET receipt=$1::jsonb', [JSON.stringify(saved)]);
      await query('access', 'UPDATE public.rezics_qa_history_transition SET source=$1', [retainedQaSource]);
      await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('Unknown or partial access transition history');
      await query('access', 'UPDATE public.rezics_qa_history_transition SET source=$1,backup_sha256=$2', [source, '0'.repeat(64)]);
      await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('Unknown or partial access transition history');
      await query('access', 'UPDATE public.rezics_qa_history_transition SET backup_sha256=$1', [options.backupSha256]);
      const oldName = lineage.renames[0]!.source;
      await query('access', 'INSERT INTO public.rezics_local_migration(name) VALUES ($1)', [oldName]);
      await expect(transitionQaHistory({ ...options, adopt: true })).rejects.toThrow('Unknown or partial access transition history');
      await query('access', 'DELETE FROM public.rezics_local_migration WHERE name=$1', [oldName]);
    }
    // Construct the durable state of an interruption between owner commits using
    // already-verified receipts: Access committed, relay still untracked.
    await query('relay', 'DROP TABLE public.rezics_qa_history_transition, public.rezics_local_migration');
    const resumed = await transitionQaHistory({ ...options, adopt: true });
    expect(resumed.owners.access.status).toBe('replayed');
    expect(resumed.owners.relay.status).toBe('adopted');
    expect({ access: digest(dump('access')), relay: digest(dump('relay')) }).toEqual(before);
    // Retry retains post-adoption application changes instead of replaying seeds.
    await query('access', "UPDATE access.principal SET library_rating_version=23 WHERE account_subject='retained-subject'");
    for (let attempt = 0; attempt < 2; attempt++) {
      const replayed = await transitionQaHistory({ ...options, adopt: true });
      expect(replayed.owners.access.status).toBe('replayed');
      expect(replayed.owners.access.schemaSha256).toBe(adopted.owners.access.schemaSha256);
    }
    expect((await query('access', `SELECT enforcement_epoch::int FROM access.principal
      WHERE account_subject='retained-subject'`)).rows[0].enforcement_epoch).toBe(7);
    if (source === retainedBookRecipeSource) {
      // The canonical runner skips all three renamed DDL/backfills and applies
      // the actual current migration, not a mock or filename-only assertion.
      expect(await migrateTracked(ownerUrl('access'), repositoryRoot, migrationDirectories.access))
        .toEqual([`${migrationDirectories.access}/2609_standing_rating_bounded_progress.sql`]);
      expect(await migrateTracked(ownerUrl('access'), repositoryRoot, migrationDirectories.access)).toEqual([]);
      expect((await query('access', "SELECT to_regclass('access.rating_standing_progress') IS NOT NULL AS present")).rows[0].present)
        .toBe(true);
      const upgraded = { access: digest(dump('access')), relay: digest(dump('relay')) };
      expect((await transitionQaHistory({ ...options, adopt: true })).owners.access.status).toBe('replayed');
      expect({ access: digest(dump('access')), relay: digest(dump('relay')) }).toEqual(upgraded);
    }
    // A real subsequent ALTER and data upgrade runs through the owner runner.
    const upgradeRoot = join(directory, 'upgrade');
    const upgradeDirectory = join(upgradeRoot, migrationDirectories.access);
    cpSync(join(source === retainedBookRecipeSource ? repositoryRoot : sourceRoot, migrationDirectories.access), upgradeDirectory, { recursive: true });
    writeFileSync(join(upgradeDirectory, '90000_retained_upgrade.sql'), `ALTER TABLE access.principal ADD COLUMN upgrade_verified boolean NOT NULL DEFAULT false;
      UPDATE access.principal SET upgrade_verified=true WHERE account_subject='retained-subject';`);
    expect(await migrateTracked(ownerUrl('access'), upgradeRoot, migrationDirectories.access))
      .toEqual([`${migrationDirectories.access}/90000_retained_upgrade.sql`]);
    expect(await migrateTracked(ownerUrl('access'), upgradeRoot, migrationDirectories.access)).toEqual([]);
    // This deliberate row update runs the retained enforcement trigger. Adoption
    // and retries left epoch 7 untouched; the genuine upgrade must advance it.
    expect((await query('access', `SELECT id::text,enforcement_epoch::int,library_rating_version::int,upgrade_verified
      FROM access.principal WHERE account_subject='retained-subject'`)).rows[0]).toEqual({
      id: '71d7f024-d173-4f6d-ae9f-83eb2115f028', enforcement_epoch: 8, library_rating_version: 23, upgrade_verified: true,
    });
    expect(digest(readFileSync(options.backup))).toBe(options.backupSha256);
    expect((await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'qa_history_%'")).rows).toEqual([]);
  }, 360_000);
});

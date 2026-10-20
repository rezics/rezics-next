import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { readEnv } from '../dev/config.ts';
import { dockerEnvironment, run } from '../fixture/stack.ts';
import { loadCompatibility, type LoadCompatibility } from '../load/compatibility.ts';
import { migrateTracked, migrationDirectories, migrationRecords, repositoryRoot, withDatabaseLock } from '../ops/migrate.ts';

// These are two inspected historical bootstraps, not an inference
// that an arbitrary untracked database has run the current migration inventory.
export const retainedQaSource = '759244e365ad64bcb97fac0ea7d7b9caebe144b2';
export const retainedBookRecipeSource = '4a616b079a364b8f5ac7fe4d4ff56bc99849e766';
const retainedSources = [retainedQaSource, retainedBookRecipeSource];
// These retain the component ledger, publication fences and affected-cut
// lineage respectively. Their DDL/backfills must never run again under a new
// filename. Byte identity only permits naming the history that the full frozen
// schema/data-effect replay below has independently verified.
const bookRecipeRenames = [
  { source: '2045_standing_rating_components', current: '2606_standing_rating_components',
    sha256: '65d2a75a859182d5808f7ad8ca3b197006c9d684a7c1bb41c005880e800314f5' },
  { source: '2077_standing_rating_publication', current: '2607_standing_rating_publication',
    sha256: '6583a1657afe45a3ee250a0ec4eb11fc244bf88820b05bf7a7e739ad5cce7b41' },
  { source: '2606_standing_rating_affected_cuts', current: '2608_standing_rating_affected_cuts',
    sha256: '7d1f1743e6b8c771b275fe8dd1afa601cab07fb62b553699bce52ab76f2b4677' },
].map(rename => ({ ...rename,
  source: `${migrationDirectories.access}/${rename.source}.sql`,
  current: `${migrationDirectories.access}/${rename.current}.sql`,
}));
const owners = ['access', 'relay'] as const;
type Owner = (typeof owners)[number];
const tracker = 'public.rezics_local_migration';
const transition = 'public.rezics_qa_history_transition';
const applicationName = 'rezics-qa-history-transition';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface Backup {
  format: string;
  project: string;
  runId: string;
  compatibility: LoadCompatibility;
}

export interface QaHistoryReceipt {
  source: string;
  backupSha256: string;
  backupProject: string;
  restoredProject: string;
  owners: Record<Owner, {
    status: 'verified' | 'adopted' | 'replayed';
    migrations: string[];
    schemaSha256: string;
    effectsSha256: string;
    /** Required for the second retained source; older receipts stay valid. */
    lineage?: {
      backupProject: string;
      restoredProject: string;
      sourceMigrations: string[];
      renames: typeof bookRecipeRenames;
    };
  }>;
}

export interface QaHistoryOptions {
  stackDirectory: string;
  backup: string;
  backupSha256: string;
  source: string;
  /** Verification is the default. Adoption is never part of ordinary startup. */
  adopt?: boolean;
}

/** The expected digest is an independently retained backup receipt, not a new
 * digest silently computed and accepted from whatever file the caller supplies. */
export function verifyQaHistoryManifest(bytes: Buffer, expectedSha256: string,
  expected: LoadCompatibility, source = retainedQaSource): Backup {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256)
    throw new Error('Missing evidence: retained backup bytes matching the independently recorded SHA-256');
  const backup = JSON.parse(bytes.toString('utf8')) as Backup;
  if (backup.format !== 'command-catalogue-backup-v1'
    || !/^rezics-catalogue-(?:g1038|work-profile|corpus)-[a-z0-9-]+$/.test(backup.project)
    || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(backup.runId))
    throw new Error('Missing evidence: supported retained QA backup identity');
  const actual = backup.compatibility;
  const paths = Object.keys(expected.files).sort();
  if (!actual || actual.digest !== expected.digest || !actual.files
    || Object.keys(actual.files).length !== paths.length
    || paths.some(path => actual.files[path] !== expected.files[path]))
    throw new Error(`Missing evidence: complete unchanged storage and SQL byte inventory at ${source}`);
  return backup;
}

/** This checks receipt names, never whether SQL has actually run. Only the
 * explicit transition combines it with the pinned schema and data replay. */
export function verifyQaHistoryMigrations(source: string, sourceRoot: string, owner: Owner,
  currentRoot = repositoryRoot) {
  if (!retainedSources.includes(source)) throw new Error('Unsupported QA history source');
  const sourceMigrations = migrationRecords(sourceRoot, owner).map(file => file.name);
  if (source === retainedQaSource) return { migrations: sourceMigrations, sourceMigrations, renames: [] };
  const renames = owner === 'access' ? bookRecipeRenames : [];
  const current = migrationRecords(currentRoot, owner).map(file => file.name);
  if (renames.some(rename => !sourceMigrations.includes(rename.source) || current.includes(rename.source)))
    throw new Error(`Missing evidence: exact ${owner} historical filename transitions`);
  const mapped = sourceMigrations.map(name => {
    const rename = renames.find(item => item.source === name);
    const canonical = rename?.current ?? name;
    const digest = sha256(readFileSync(join(sourceRoot, name)));
    if ((rename && digest !== rename.sha256) || !current.includes(canonical)
      || sha256(readFileSync(join(currentRoot, canonical))) !== digest)
      throw new Error(`Missing evidence: unchanged historical SQL identity ${name} -> ${canonical}`);
    return canonical;
  });
  if (new Set(mapped).size !== mapped.length) throw new Error('Conflicting historical migration identities');
  return { migrations: current.filter(name => mapped.includes(name)), sourceMigrations,
    renames: renames.map(rename => ({ ...rename })) };
}

function pinnedSourceDirectory(source: string): string {
  mkdirSync(join(repositoryRoot, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repositoryRoot, '.temp/qa-history-source-'));
  try {
    const archive = spawnSync('git', ['archive', '--format=tar', source,
      ...Object.values(migrationDirectories), 'generated/model/manifest.json',
      'infra/dev/compose.yaml', 'infra/jena/fuseki-text.ttl', 'infra/jena/fuseki-text-qa.ttl',
      'services/account/package.json'], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`Missing evidence: local Git object ${source}`);
    const extracted = spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout });
    if (extracted.status !== 0) throw new Error('Unable to stage pinned QA SQL');
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function localTemporaryPath(path: string): string {
  const actual = realpathSync(resolve(repositoryRoot, path));
  const local = relative(repositoryRoot, actual);
  if (local !== '.temp' && !local.startsWith('.temp/'))
    throw new Error('QA history inputs must stay in this checkout .temp');
  return actual;
}

function targetStack(directory: string, sourceRoot: string, backup: Backup) {
  const path = localTemporaryPath(directory);
  const project = basename(path);
  if (relative(join(repositoryRoot, '.temp/stack'), path) !== project
    || !/^rezics-qa-[a-z0-9][a-z0-9-]{0,30}$/.test(project)
    || project === `rezics-qa-${backup.runId}`)
    throw new Error('QA history requires a distinct disposable restored QA project');
  const compose = readEnv(join(path, 'compose.env'));
  const apps = readEnv(join(path, 'apps.env'));
  if (compose.REZICS_STACK_STORAGE !== 'persistent' || apps.NODE_ENV === 'production')
    throw new Error('QA history requires a persistent disposable QA copy');
  const container = `${project}-postgres-1`;
  const docker = dockerEnvironment();
  const details = run('docker', ['inspect', '--format',
    '{{json .Config.Labels}}\n{{json .Mounts}}\n{{json .NetworkSettings.Ports}}\n{{.Config.Image}}', container], docker).trim().split('\n');
  const labels = JSON.parse(details[0]!) as Record<string, string>;
  const mounts = JSON.parse(details[1]!) as { Type: string; Name: string; Destination: string }[];
  const ports = JSON.parse(details[2]!) as Record<string, { HostIp: string; HostPort: string }[]>;
  const image = /^\s+image: (postgres:[^\s]+)$/m.exec(readFileSync(join(sourceRoot, 'infra/dev/compose.yaml'), 'utf8'))?.[1];
  if (labels['com.docker.compose.project'] !== project || labels['com.docker.compose.service'] !== 'postgres'
    || details[3] !== image
    || !mounts.some(mount => mount.Type === 'volume' && mount.Name === `${project}_postgres_data`
      && mount.Destination === '/var/lib/postgresql')
    || !ports['5432/tcp']?.some(port => port.HostIp === '127.0.0.1' && port.HostPort === compose.POSTGRES_PORT))
    throw new Error('QA history target container, storage, engine or endpoint does not match the owned copy');
  const urls = { access: apps.ACCESS_DATABASE_URL!, relay: apps.MAIN_RELAY_DATABASE_URL ?? apps.ACCOUNT_RELAY_DATABASE_URL! };
  for (const owner of owners) {
    const url = new URL(urls[owner]);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || url.port !== compose.POSTGRES_PORT || url.pathname !== `/${owner}` || url.username !== owner)
      throw new Error(`QA history ${owner} endpoint differs from the restored owner`);
  }
  const adminUrl = new URL(urls.access);
  adminUrl.username = 'postgres';
  adminUrl.password = compose.POSTGRES_PASSWORD!;
  adminUrl.pathname = '/postgres';
  return { project, backupProject: backup.project, container, urls, adminUrl: adminUrl.href, docker };
}

/** Keep definitions, owners, grants, functions, triggers, policies and index
 * validity. Only pg_dump's random guard and our two metadata tables are omitted.
 * A schema dump cannot prove data effects: frozen QA templates are checked too.
 * https://www.postgresql.org/docs/18/app-pgdump.html */
function schemaDump(container: string, database: string, docker: NodeJS.ProcessEnv): string {
  return run('docker', ['exec', '--user', 'postgres', container, 'pg_dump',
    '--username=postgres', `--dbname=${database}`, '--schema-only',
    `--exclude-table=${tracker}`, `--exclude-table=${transition}`], docker)
    .replace(/^\\(?:un)?restrict .+$/gm, '').trim();
}

interface SeedEffect { table: string; values: Record<string, unknown>; key: string[]; fixed: boolean }
const fixedSeedTables = new Set([
  'access.alias_reserved_word', 'access.derived_generation_family', 'access.governance_role',
  'access.operational_bounds_profile', 'quota.policy_revision',
]);

/** In the pinned fresh bootstrap all data backfills run before any corpus is
 * admitted. Compare every frozen template row, not just an inventory count.
 * Timestamp defaults and one random revision differ between independent replays.
 * The populated copy may advance counters, gates, policies and recovery state;
 * its persistent seed keys and immutable seed values must still exist. */
async function seedEffects(client: Client): Promise<SeedEffect[]> {
  const tables = (await client.query<{ schema: string; name: string; volatile: string[]; key: string[] }>(`
    SELECT n.nspname AS schema, c.relname AS name,
      ARRAY(SELECT a.attname::text FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND t.typname IN ('timestamp','timestamptz')) AS volatile,
      ARRAY(SELECT a.attname::text FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        WHERE i.indrelid=c.oid AND i.indisprimary ORDER BY k.ord) AS key
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname !~ '^pg_' ORDER BY n.nspname,c.relname`)).rows;
  const effects: SeedEffect[] = [];
  for (const table of tables) {
    const name = `${table.schema}.${table.name}`;
    if ([tracker, transition].includes(name)) continue;
    const volatile = name === 'access.realm_growth_position' ? [...table.volatile, 'revision'] : table.volatile;
    const rows = (await client.query<{ value: Record<string, unknown> }>(
      `SELECT to_jsonb(t) - $1::text[] AS value FROM ${identifier(table.schema)}.${identifier(table.name)} t`, [volatile])).rows;
    if (rows.length && !table.key.length) throw new Error(`Missing evidence: stable seed identity for ${name}`);
    for (const row of rows) effects.push({ table: name, values: row.value, key: table.key, fixed: fixedSeedTables.has(name) });
  }
  return effects.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
}

async function verifySeedKeys(client: PoolClient, effects: SeedEffect[]): Promise<void> {
  for (const effect of effects) {
    const values = effect.fixed ? effect.values
      : Object.fromEntries(effect.key.map(key => [key, effect.values[key]]));
    const [schema, table] = effect.table.split('.') as [string, string];
    const exists = await client.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM ${identifier(schema)}.${identifier(table)} t WHERE to_jsonb(t) @> $1::jsonb) AS present`, [JSON.stringify(values)]);
    if (!exists.rows[0]!.present) throw new Error(`Missing or drifted baseline data effect: ${effect.table}`);
  }
}

interface OwnerState {
  client: PoolClient;
  names: string[];
  schema: string;
  effects: SeedEffect[];
  lineage?: QaHistoryReceipt['owners'][Owner]['lineage'];
  previous?: QaHistoryReceipt['owners'][Owner];
}

async function ownerState(client: PoolClient, owner: Owner, sourceRoot: string,
  target: ReturnType<typeof targetStack>, options: QaHistoryOptions): Promise<OwnerState> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='540s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  const tables = (await client.query<{ name: string }>(`SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p')
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
    ORDER BY n.nspname,c.relname`)).rows;
  if (tables.length) await client.query(`LOCK TABLE ${tables.map(table => table.name).join(', ')} IN SHARE MODE`);
  const historyNames = verifyQaHistoryMigrations(options.source, sourceRoot, owner);
  const names = historyNames.migrations;
  const lineage = options.source === retainedBookRecipeSource ? {
    backupProject: target.backupProject, restoredProject: target.project,
    sourceMigrations: historyNames.sourceMigrations, renames: historyNames.renames,
  } : undefined;
  const present = (await client.query<{ history: string | null; transition: string | null }>(
    'SELECT to_regclass($1)::text AS history, to_regclass($2)::text AS transition', [tracker, transition])).rows[0]!;
  const history = present.history ? (await client.query<{ name: string }>(`SELECT name FROM ${tracker}`)).rows.map(row => row.name) : [];
  if (present.transition) {
    const recorded = (await client.query<{ source: string; backup_sha256: string; receipt: QaHistoryReceipt['owners'][Owner] }>(
      `SELECT source, backup_sha256, receipt FROM ${transition}`)).rows;
    const previousLineage = recorded[0]?.receipt.lineage;
    if (recorded.length !== 1 || recorded[0]!.source !== options.source || recorded[0]!.backup_sha256 !== options.backupSha256
      || JSON.stringify(recorded[0]!.receipt.migrations) !== JSON.stringify(names)
      || (lineage && (!previousLineage || previousLineage.backupProject !== lineage.backupProject
        || previousLineage.restoredProject !== lineage.restoredProject
        || JSON.stringify(previousLineage.sourceMigrations) !== JSON.stringify(lineage.sourceMigrations)
        || previousLineage.renames?.length !== lineage.renames.length
        || lineage.renames.some((rename, index) => {
          const previous = previousLineage.renames[index];
          return previous?.source !== rename.source || previous.current !== rename.current || previous.sha256 !== rename.sha256;
        })))
      || names.some(name => !history.includes(name))
      || history.some(name => !migrationRecords(repositoryRoot, owner).some(file => file.name === name)))
      throw new Error(`Unknown or partial ${owner} transition history`);
    return { client, names, schema: '', effects: [], lineage, previous: recorded[0]!.receipt };
  }
  if (history.length) throw new Error(`Unknown or partial ${owner} migration history; no verified QA transition receipt`);
  const templateUrl = new URL(target.urls[owner]);
  templateUrl.pathname = `/${owner}_tpl`;
  const template = new Client({ connectionString: templateUrl.href, application_name: applicationName });
  await template.connect();
  try {
    const schema = schemaDump(target.container, owner, target.docker);
    if (schema !== schemaDump(target.container, `${owner}_tpl`, target.docker))
      throw new Error(`Drifted ${owner} schema differs from its frozen QA bootstrap template`);
    const invalid = await client.query(`SELECT 1 FROM pg_index WHERE NOT indisvalid OR NOT indisready`);
    if (invalid.rowCount) throw new Error(`Drifted ${owner} contains an incomplete index build`);
    const effects = await seedEffects(template);
    await verifySeedKeys(client, effects);
    return { client, names, schema, effects, lineage };
  } finally { await template.end(); }
}

/** Explicit retained-copy adoption. The existing release lock is held through
 * verification and receipt commit; per-owner transactions roll back any failed
 * receipt write. Session locks survive rollback, as the owner runner requires.
 * https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS */
export async function transitionQaHistory(options: QaHistoryOptions): Promise<QaHistoryReceipt> {
  if (!retainedSources.includes(options.source)) throw new Error(`Unsupported QA history source; expected ${retainedSources.join(' or ')}`);
  const startedAt = Date.now();
  const sourceRoot = pinnedSourceDirectory(options.source);
  let admin: Client | undefined;
  const references: string[] = [];
  try {
    const backup = verifyQaHistoryManifest(readFileSync(localTemporaryPath(options.backup)),
      options.backupSha256, loadCompatibility(sourceRoot), options.source);
    const target = targetStack(options.stackDirectory, sourceRoot, backup);
    admin = new Client({ connectionString: target.adminUrl, application_name: applicationName });
    await admin.connect();
    const active = await admin.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname = ANY($1::text[]) AND backend_type='client backend'`,
    [owners.flatMap(owner => [owner, `${owner}_tpl`])]);
    if (active.rowCount) throw new Error('Stop all restored-copy owner clients before QA history verification');
    return await withDatabaseLock(target.urls.access, async (_accessPool, access) =>
      withDatabaseLock(target.urls.relay, async (_relayPool, relay) => {
        const clients = { access, relay };
        try {
          const states = {} as Record<Owner, OwnerState>;
          // Verify both owners before either gains a receipt. An interrupted
          // cross-database commit is recognized by the durable per-owner receipt.
          for (const owner of owners) states[owner] = await ownerState(clients[owner], owner, sourceRoot, target, options);
          for (const owner of owners) {
            const state = states[owner];
            if (state.previous) continue;
            const reference = `qa_history_${owner}_${randomUUID().replaceAll('-', '')}`;
            await admin!.query(`CREATE DATABASE ${identifier(reference)} OWNER ${owner}`);
            references.push(reference);
            const url = new URL(target.urls[owner]);
            url.pathname = `/${reference}`;
            await migrateTracked(url.href, sourceRoot, migrationDirectories[owner]);
            if (schemaDump(target.container, reference, target.docker) !== state.schema)
              throw new Error(`Drifted ${owner} baseline definitions do not match the pinned SQL replay`);
            const db = new Client({ connectionString: url.href, application_name: applicationName });
            await db.connect();
            try {
              if (JSON.stringify(await seedEffects(db)) !== JSON.stringify(state.effects))
                throw new Error(`Missing or drifted ${owner} frozen bootstrap data effects`);
            } finally { await db.end(); }
            if (Date.now() - startedAt > 600_000) throw new Error('QA history verification exceeded the 600-second preparation budget');
          }
          const receipt: QaHistoryReceipt = {
            source: options.source, backupSha256: options.backupSha256,
            backupProject: backup.project, restoredProject: target.project,
            owners: {} as QaHistoryReceipt['owners'],
          };
          for (const owner of owners) {
            const state = states[owner];
            receipt.owners[owner] = state.previous ? { ...state.previous, status: 'replayed' } : {
              status: options.adopt ? 'adopted' : 'verified', migrations: state.names,
              schemaSha256: sha256(state.schema), effectsSha256: sha256(JSON.stringify(state.effects)),
              ...(state.lineage ? { lineage: state.lineage } : {}),
            };
            if (!options.adopt || state.previous) continue;
            await state.client.query(`CREATE TABLE IF NOT EXISTS ${tracker} (
              name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
            await state.client.query(`INSERT INTO ${tracker}(name) SELECT unnest($1::text[])`, [state.names]);
            await state.client.query(`CREATE TABLE ${transition} (
              source text NOT NULL, backup_sha256 text NOT NULL, receipt jsonb NOT NULL,
              verified_at timestamptz NOT NULL DEFAULT now())`);
            await state.client.query(`INSERT INTO ${transition}(source,backup_sha256,receipt) VALUES ($1,$2,$3::jsonb)`,
              [options.source, options.backupSha256, JSON.stringify(receipt.owners[owner])]);
          }
          for (const owner of owners) await clients[owner].query(options.adopt ? 'COMMIT' : 'ROLLBACK');
          return receipt;
        } finally {
          await Promise.all(owners.map(owner => clients[owner].query('ROLLBACK')));
        }
      }, 5_000), 5_000);
  } finally {
    try {
      for (const reference of references) await admin!.query(`DROP DATABASE ${identifier(reference)} WITH (FORCE)`);
    } finally {
      await admin?.end();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) flags.set(args[index]!, args[index + 1]!);
  if (!['verify', 'adopt'].includes(operation!) || args.length !== 10 || flags.size !== 5
    || ['--stack', '--backup', '--backup-sha256', '--source', '--receipt'].some(flag => !flags.get(flag)))
    throw new Error('Use verify|adopt --stack <restored-stack-directory> --backup <backup.json> --backup-sha256 <retained-digest> --source <source-pin> --receipt <local-output.json>');
  const output = resolve(repositoryRoot, flags.get('--receipt')!);
  localTemporaryPath(dirname(output));
  // Reserve a fresh local output before adoption, refusing symlinks and existing
  // evidence files. Neither a retry nor an output typo overwrites provenance.
  const descriptor = openSync(output, 'wx', 0o600);
  try {
    const receipt = await transitionQaHistory({ stackDirectory: flags.get('--stack')!, backup: flags.get('--backup')!,
      backupSha256: flags.get('--backup-sha256')!, source: flags.get('--source')!, adopt: operation === 'adopt' });
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
  } catch (error) {
    rmSync(output);
    throw error;
  } finally { closeSync(descriptor); }
}

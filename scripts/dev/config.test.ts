import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS_PORT, appEnvironment, assertSavedStackRawUpdate, assertSavedStackStorage,
  composeProcessEnvironment, ensureSecrets,
  parseOptions, projectName, stackDirectory, stackMemorySettings } from './config.ts';

const roots: string[] = [];
mkdirSync('.temp', { recursive: true });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('P0.1 rejects ambiguous or unsafe stack project names', () => {
  expect(projectName(parseOptions(['--profile', 'dev']))).toBe('rezics-dev');
  expect(projectName(parseOptions(['--profile', 'qa', '--run-id', 'batch-42']))).toBe('rezics-qa-batch-42');
  expect(() => projectName(parseOptions(['--profile', 'qa']))).toThrow('requires --run-id');
  expect(() => parseOptions(['--profile', 'qa', '--run-id', '../escape'])).toThrow();
  expect(() => parseOptions(['--profile', 'dev', '--run-id', 'x'])).toThrow();
  expect(() => parseOptions(['--persistent'])).toThrow('--persistent requires --profile qa');
  expect(parseOptions(['--profile', 'qa', '--run-id', 'rebuild', '--persistent']).persistent).toBe(true);
  expect(() => parseOptions(['--profile', 'qa', '--run-id', 'raw', '--raw-update']))
    .toThrow('--raw-update requires --profile qa --persistent');
  expect(() => parseOptions(['--profile', 'dev', '--raw-update', '--persistent']))
    .toThrow();
  expect(parseOptions(['--profile', 'qa', '--run-id', 'raw', '--persistent', '--raw-update'])
    .rawUpdate).toBe(true);
  expect(parseOptions(['--profile', 'qa', '--run-id', 'browser', '--accounts-app']).accountsApp).toBe(true);
  expect(() => parseOptions(['--accounts-app'])).toThrow('--accounts-app requires --profile qa');
});

test('P0.1 stack credentials and lineage persist across starts and remain private', () => {
  const root = mkdtempSync('.temp/p01-config-test-'); roots.push(root);
  const options = { profile: 'dev' as const };
  const first = ensureSecrets(root, options);
  const second = ensureSecrets(root, options);
  expect(second).toEqual(first);
  expect(first.POSTGRES_PASSWORD).toHaveLength(64);
  expect(first.FUSEKI_MAINTENANCE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(first.FUSEKI_COMMAND_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(first.FUSEKI_COMMAND_TOKEN).not.toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(first.FUSEKI_TITLE_ADMISSION_KEY).toMatch(/^[0-9a-f]{64}$/);
  expect(first.FUSEKI_TITLE_ADMISSION_KEY).not.toBe(first.FUSEKI_COMMAND_TOKEN);
  expect(first.FUSEKI_TITLE_ADMISSION_KEY).not.toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(first.MAIN_DATA_EPOCH).toBeTruthy();
  expect(first.MAIN_ROUTING_EPOCH).toBeTruthy();
  const dir = stackDirectory(root, options);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'compose.env')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'compose.env'), 'utf8')).toContain('REZICS_ACCESS_PASSWORD=');
  const apps = appEnvironment(first, dir);
  expect(apps.ACCESS_DATABASE_URL).toContain(`:${first.REZICS_ACCESS_PASSWORD}@127.0.0.1:5432/access`);
  expect(apps.CONTENT_DATABASE_URL).toContain(`:${first.REZICS_CONTENT_PASSWORD}@127.0.0.1:5432/content`);
  expect(apps.MAIN_RELAY_DATABASE_URL).toContain(`:${first.REZICS_RELAY_PASSWORD}@127.0.0.1:5432/relay`);
  expect(apps.MAIN_RELAY_CONSUMER).toBe('main-graph-v1');
  expect(apps.MAIN_OBJECT_DIRECTORY).toBe(join(dir, 'objects'));
  expect(apps.MAIN_S3_ENDPOINT).toBe(`http://127.0.0.1:${first.RUSTFS_PORT}`);
  expect(apps.MAIN_S3_ACCESS_KEY).toBe(first.RUSTFS_ACCESS_KEY);
  expect(apps.MAIN_S3_SECRET_KEY).toBe(first.RUSTFS_SECRET_KEY);
  expect(apps.FUSEKI_MAINTENANCE_TOKEN).toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(apps.FUSEKI_COMMAND_TOKEN).toBe(first.FUSEKI_COMMAND_TOKEN);
  expect(apps.FUSEKI_TITLE_ADMISSION_KEY).toBe(first.FUSEKI_TITLE_ADMISSION_KEY);
  expect(apps.MAIN_DATA_EPOCH).toBe(first.MAIN_DATA_EPOCH);
  expect(apps.MAIN_ORIGIN).toBe('http://127.0.0.1:3001');
  expect(apps.ACCOUNT_ORIGIN).toBe(`http://127.0.0.1:${ACCOUNTS_PORT}`);
  expect(apps.MAIN_RESOURCE).toBe(apps.ACCOUNT_MAIN_RESOURCE);
  const composePath = join(dir, 'compose.env');
  writeFileSync(composePath, readFileSync(composePath, 'utf8')
    .replace(/^FUSEKI_(?:MAINTENANCE|COMMAND)_TOKEN=.*\n/gm, ''), { mode: 0o600 });
  const upgraded = ensureSecrets(root, options);
  expect(upgraded.POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
  expect(upgraded.FUSEKI_MAINTENANCE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(upgraded.FUSEKI_MAINTENANCE_TOKEN).not.toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(upgraded.FUSEKI_COMMAND_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(upgraded.FUSEKI_COMMAND_TOKEN).not.toBe(first.FUSEKI_COMMAND_TOKEN);
  expect(statSync(composePath).mode & 0o777).toBe(0o600);
});

test('P0.1 QA projects keep independent credentials and endpoints', () => {
  const root = mkdtempSync('.temp/p01-config-test-'); roots.push(root);
  const a = ensureSecrets(root, { profile: 'qa', runId: 'a' }, { MAIN_PORT: 14001, ACCOUNT_PORT: 14002,
    POSTGRES_PORT: 15401, FUSEKI_PORT: 13001 });
  const b = ensureSecrets(root, { profile: 'qa', runId: 'b' }, { MAIN_PORT: 14011, ACCOUNT_PORT: 14012,
    POSTGRES_PORT: 15402, FUSEKI_PORT: 13002 });
  expect(a.POSTGRES_PASSWORD).not.toBe(b.POSTGRES_PASSWORD);
  expect(a.FUSEKI_MAINTENANCE_TOKEN).not.toBe(b.FUSEKI_MAINTENANCE_TOKEN);
  expect(a.FUSEKI_COMMAND_TOKEN).not.toBe(b.FUSEKI_COMMAND_TOKEN);
  expect(a.MAIN_DATA_EPOCH).not.toBe(b.MAIN_DATA_EPOCH);
  expect(appEnvironment(a, root).FUSEKI_URL).toContain(':13001/');
  expect(appEnvironment(b, root).FUSEKI_URL).toContain(':13002/');
  expect(appEnvironment(a, root).MAIN_ORIGIN).toContain(`:${a.MAIN_PORT}`);
  // QA tiers run the Account service alone; it stays the public origin there.
  expect(a.ACCOUNTS_PORT).toBeUndefined();
  expect(appEnvironment(a, root).ACCOUNT_BASE_URL).toBe(`http://127.0.0.1:${a.ACCOUNT_PORT}`);
  expect(appEnvironment(a, root).ACCOUNT_ORIGIN).toBe(`http://127.0.0.1:${a.ACCOUNT_PORT}`);
  expect(appEnvironment({ ...a, MAILPIT_SMTP_PORT: '14025' }, root).ACCOUNT_SMTP_PORT).toBe('14025');
  const nested = composeProcessEnvironment({ ...a, DOCKER_HOST: 'unix:///run/docker.sock' }, b);
  expect(nested.FUSEKI_MAINTENANCE_TOKEN).toBe(b.FUSEKI_MAINTENANCE_TOKEN);
  expect(nested.FUSEKI_COMMAND_TOKEN).toBe(b.FUSEKI_COMMAND_TOKEN);
  expect(nested.POSTGRES_PASSWORD).toBe(b.POSTGRES_PASSWORD);
  expect(nested.FUSEKI_PORT).toBe(b.FUSEKI_PORT);
  expect(nested.DOCKER_HOST).toBe('unix:///run/docker.sock');
});

test('shared dev storage wins host OOM selection while QA and worktree Fuseki stay bounded', () => {
  const root = mkdtempSync('.temp/stack-memory-config-'); roots.push(root);
  const dev = ensureSecrets(root, { profile: 'dev' });
  const qa = ensureSecrets(root, { profile: 'qa', runId: 'integration' });
  const worktree = ensureSecrets(root, { profile: 'qa', runId: 'wt-g403', accountsApp: true });
  expect(dev.REZICS_FUSEKI_OOM_SCORE_ADJ).toBe('-900');
  expect(dev.REZICS_POSTGRES_OOM_SCORE_ADJ).toBe('-800');
  expect(dev.REZICS_FUSEKI_MEMORY_LIMIT).toBe('0');
  expect(qa.REZICS_FUSEKI_OOM_SCORE_ADJ).toBe('0');
  expect(qa.REZICS_POSTGRES_OOM_SCORE_ADJ).toBe('0');
  expect(qa.REZICS_FUSEKI_MEMORY_LIMIT).toBe('7g');
  expect(worktree.REZICS_FUSEKI_MEMORY_LIMIT).toBe('7g');
  expect(worktree.REZICS_FUSEKI_JVM_ARGS).toContain('-Xmx1536m');

  const compose = join(import.meta.dir, '../../infra/dev/compose.yaml');
  for (const [saved, oom, memory] of [[dev, -900, 0], [qa, 0, 7 * 1024 ** 3],
    [worktree, 0, 7 * 1024 ** 3]] as const) {
    const resolved = Bun.spawnSync(['docker', 'compose', '-f', compose, 'config', '--format', 'json'],
      { env: composeProcessEnvironment(process.env, saved) });
    expect(resolved.exitCode).toBe(0);
    const services = JSON.parse(new TextDecoder().decode(resolved.stdout)).services;
    expect(services.fuseki.oom_score_adj ?? 0).toBe(oom);
    expect(services.postgres.oom_score_adj ?? 0).toBe(oom === 0 ? 0 : -800);
    expect(Number(services.fuseki.mem_limit ?? 0)).toBe(memory);
    expect(services.fuseki.environment.JVM_ARGS).toBe(saved.REZICS_FUSEKI_JVM_ARGS);
  }

  const devPath = join(stackDirectory(root, { profile: 'dev' }), 'compose.env');
  writeFileSync(devPath, readFileSync(devPath, 'utf8')
    .replace(/^REZICS_(?:FUSEKI|POSTGRES)_(?:OOM_SCORE_ADJ|MEMORY_LIMIT|JVM_ARGS)=.*\n/gm, ''),
  { mode: 0o600 });
  const upgraded = ensureSecrets(root, { profile: 'dev' });
  expect(upgraded.REZICS_FUSEKI_OOM_SCORE_ADJ).toBe('-900');
  expect(upgraded.REZICS_POSTGRES_OOM_SCORE_ADJ).toBe('-800');
  expect(upgraded.REZICS_FUSEKI_MEMORY_LIMIT).toBe('0');
  expect(upgraded.REZICS_FUSEKI_JVM_ARGS).toBe('-Xms256m -Xmx2g');
});

test('disposable QA caps every service beside Fuseki and still accepts an override', () => {
  const root = mkdtempSync('.temp/qa-memory-caps-'); roots.push(root);
  const saved = ensureSecrets(root, { profile: 'qa', runId: 'caps' });
  const base = join(import.meta.dir, '../../infra/dev/compose.yaml');
  const overlay = join(import.meta.dir, '../../infra/dev/compose.qa.yaml');
  const overlayText = readFileSync(overlay, 'utf8');
  expect(overlayText).toContain('mem_limit: ${REZICS_FUSEKI_MEMORY_LIMIT:-2g}');
  const resolve = (extra: Record<string, string>) => {
    const env = composeProcessEnvironment(process.env, saved);
    for (const name of ['REZICS_POSTGRES_MEMORY_LIMIT', 'REZICS_RUSTFS_MEMORY_LIMIT',
      'REZICS_TOXIPROXY_MEMORY_LIMIT', 'REZICS_MAILPIT_MEMORY_LIMIT']) delete env[name];
    const resolved = Bun.spawnSync(['docker', 'compose', '-f', base, '-f', overlay, 'config', '--format', 'json'],
      { env: { ...env, ...extra } });
    expect(resolved.exitCode).toBe(0);
    return JSON.parse(new TextDecoder().decode(resolved.stdout)).services as Record<string, { mem_limit?: number }>;
  };
  const defaults = resolve({});
  expect(Number(defaults.postgres.mem_limit)).toBe(2 * 1024 ** 3);
  expect(Number(defaults.rustfs.mem_limit)).toBe(1024 ** 3);
  expect(Number(defaults.toxiproxy.mem_limit)).toBe(128 * 1024 ** 2);
  expect(Number(defaults.mailpit.mem_limit)).toBe(256 * 1024 ** 2);
  const overridden = resolve({ REZICS_POSTGRES_MEMORY_LIMIT: '1536m' });
  expect(Number(overridden.postgres.mem_limit)).toBe(1536 * 1024 ** 2);
  expect(Number(overridden.fuseki.mem_limit)).toBe(Number(defaults.fuseki.mem_limit));
});

test('a surrounding QA Fuseki cap does not bound the shared dev stack', () => {
  const surrounding = {
    REZICS_FUSEKI_MEMORY_LIMIT: '2g',
    REZICS_FUSEKI_JVM_ARGS: '-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m',
  };
  const dev = stackMemorySettings({ profile: 'dev' }, surrounding);
  expect(dev.REZICS_FUSEKI_MEMORY_LIMIT).toBe('0');
  expect(dev.REZICS_FUSEKI_OOM_SCORE_ADJ).toBe('-900');
  expect(dev.REZICS_POSTGRES_OOM_SCORE_ADJ).toBe('-800');
  expect(dev.REZICS_FUSEKI_JVM_ARGS).toBe('-Xms256m -Xmx2g');
  const qa = stackMemorySettings({ profile: 'qa', runId: 'ordinary' }, surrounding);
  expect(qa.REZICS_FUSEKI_MEMORY_LIMIT).toBe('2g');
  expect(qa.REZICS_FUSEKI_JVM_ARGS).toBe(surrounding.REZICS_FUSEKI_JVM_ARGS);
  expect(qa.REZICS_FUSEKI_OOM_SCORE_ADJ).toBe('0');
  expect(qa.REZICS_POSTGRES_OOM_SCORE_ADJ).toBe('0');
  expect(stackMemorySettings({ profile: 'qa', runId: 'ordinary' }, {}).REZICS_FUSEKI_MEMORY_LIMIT).toBe('7g');
});

test('OPS01/OPS14 PostgreSQL stack readiness waits for its final TCP server', () => {
  const compose = readFileSync(join(import.meta.dir, '../../infra/dev/compose.yaml'), 'utf8');
  const postgres = compose.match(/^  postgres:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n)/m)?.[1];
  expect(postgres).toBeDefined();
  expect(postgres).toMatch(/test: \["CMD-SHELL", "pg_isready -h 127\.0\.0\.1 -U postgres -d postgres"\]/);
});

test('SEARCH20/OPS16 isolated QA project retains its chosen storage mode', () => {
  const root = mkdtempSync('.temp/p08-rebuild-config-'); roots.push(root);
  const persistent = { profile: 'qa' as const, runId: 'rebuild', persistent: true };
  const first = ensureSecrets(root, persistent, { FUSEKI_PORT: 13041 });
  expect(first.REZICS_STACK_STORAGE).toBe('persistent');
  expect(ensureSecrets(root, persistent).FUSEKI_PORT).toBe('13041');
  expect(() => ensureSecrets(root, { profile: 'qa', runId: 'rebuild' }))
    .toThrow('Saved stack storage mode differs');
  const disposable = ensureSecrets(root, { profile: 'qa', runId: 'disposable' });
  expect(disposable.REZICS_STACK_STORAGE).toBe('tmpfs');
  expect(() => ensureSecrets(root, { profile: 'qa', runId: 'disposable', persistent: true }))
    .toThrow('Saved stack storage mode differs');
  expect(() => assertSavedStackStorage({ profile: 'qa', runId: 'rebuild' }, first))
    .toThrow('Saved stack storage mode differs');
  expect(() => assertSavedStackStorage(persistent, first)).not.toThrow();
  expect(() => assertSavedStackStorage({ profile: 'qa', runId: 'old-tmpfs', persistent: true }, {}))
    .toThrow('Saved stack storage mode differs');
  expect(() => assertSavedStackStorage({ profile: 'dev' }, {})).not.toThrow();
});

test('SEARCH17 isolated QA project cannot change its raw-update profile', () => {
  const root = mkdtempSync('.temp/p08-raw-config-'); roots.push(root);
  const raw = { profile: 'qa' as const, runId: 'raw-import', persistent: true, rawUpdate: true };
  const first = ensureSecrets(root, raw, { FUSEKI_PORT: 13042 });
  expect(first.REZICS_STACK_RAW_UPDATE).toBe('1');
  expect(ensureSecrets(root, raw).FUSEKI_PORT).toBe('13042');
  expect(() => ensureSecrets(root, { profile: 'qa', runId: 'raw-import', persistent: true }))
    .toThrow('Saved stack raw-update mode differs');
  expect(() => assertSavedStackRawUpdate(raw, first)).not.toThrow();
  expect(() => assertSavedStackRawUpdate({ profile: 'qa', runId: 'raw-import', persistent: true }, first))
    .toThrow('Saved stack raw-update mode differs');
  const ordinary = ensureSecrets(root, { profile: 'qa', runId: 'ordinary', persistent: true });
  expect(ordinary.REZICS_STACK_RAW_UPDATE).toBe('0');
  expect(() => assertSavedStackRawUpdate(raw, ordinary))
    .toThrow('Saved stack raw-update mode differs');
});

test('the Accounts app is the public Account origin only where task dev serves it', () => {
  const root = mkdtempSync('.temp/accounts-origin-config-'); roots.push(root);
  const dev = ensureSecrets(root, { profile: 'dev' });
  expect(dev.ACCOUNTS_PORT).toBe(String(ACCOUNTS_PORT));
  const apps = appEnvironment(dev, root);
  expect(apps.ACCOUNT_BASE_URL).toBe('http://127.0.0.1:3004');
  expect(apps.ACCOUNT_ISSUER).toBe('http://127.0.0.1:3004/api/auth');
  expect(apps.ACCOUNT_ORIGIN).toBe('http://127.0.0.1:3004');
  expect(apps.ACCOUNTS_PORT).toBe('3004');
  // Main verifies tokens against the service itself, not through the app.
  expect(apps.ACCOUNT_JWKS_URL).toBe('http://127.0.0.1:3002/api/auth/jwks');
  expect(apps.ACCOUNT_INTROSPECT_URL).toBe('http://127.0.0.1:3002/api/auth/oauth2/introspect');

  // A dev stack from before the Accounts app gains its port on the next start.
  const devPath = join(stackDirectory(root, { profile: 'dev' }), 'compose.env');
  writeFileSync(devPath, readFileSync(devPath, 'utf8').replace(/^ACCOUNTS_PORT=.*\n/m, ''), { mode: 0o600 });
  expect(ensureSecrets(root, { profile: 'dev' }).ACCOUNTS_PORT).toBe('3004');

  // A worktree backend gets its own port; the stack keeps it afterwards, since
  // Access principals are bound to the issuer that port implies.
  const backend = { profile: 'qa' as const, runId: 'wt-accounts', accountsApp: true };
  const created = ensureSecrets(root, backend, { ACCOUNT_PORT: 14102, ACCOUNTS_PORT: 14104 });
  expect(appEnvironment(created, root).ACCOUNT_ISSUER).toBe('http://127.0.0.1:14104/api/auth');
  expect(appEnvironment(created, root).ACCOUNT_JWKS_URL).toBe('http://127.0.0.1:14102/api/auth/jwks');
  expect(ensureSecrets(root, { profile: 'qa', runId: 'wt-accounts' }).ACCOUNTS_PORT).toBe('14104');

  // An existing QA stack first served by task dev is upgraded with the port given.
  ensureSecrets(root, { profile: 'qa', runId: 'tier' }, { ACCOUNT_PORT: 14112 });
  expect(ensureSecrets(root, { profile: 'qa', runId: 'tier' }).ACCOUNTS_PORT).toBeUndefined();
  expect(ensureSecrets(root, { profile: 'qa', runId: 'tier', accountsApp: true }, { ACCOUNTS_PORT: 14114 })
    .ACCOUNTS_PORT).toBe('14114');
});

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { PackageInstallationStore, type GenerationRequest, type InstallFault }
  from '../../../services/main/src/modules/package/install.ts';
import type { GenerationState, InstallationJournalRow, InstallationStepRow }
  from '../../../services/main/src/modules/package/install-schema.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { PackageLockStore } from '../../../services/main/src/modules/package/lock.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';
import { npmRegistryRequest } from '../fixtures/npm-registry-scenarios.ts';
import { archiveNpmFetcher, type ArchiveRegistry } from '../integration/package-install-fixtures.ts';

const root = resolve(import.meta.dir, '../../..');
const childScript = join(import.meta.dir, 'package-install-crash-child.ts');
type JournalEffect = Pick<InstallationJournalRow, 'event' | 'effect'>;
const crashJournal = {
  'after-unpack-intent': { state: 'verified', action: 'unpack',
    afterCrash: { event: 'intent', effect: 'none' },
    afterRecovery: { event: 'completed', effect: 'complete' } },
  'before-activation-commit': { state: 'activating', action: 'switch',
    afterCrash: { event: 'completed', effect: 'complete' },
    afterRecovery: { event: 'completed', effect: 'complete' } },
  'mid-remove': { state: 'activating', action: 'remove',
    afterCrash: { event: 'intent', effect: 'none' },
    afterRecovery: { event: 'completed', effect: 'complete' } },
} as const satisfies Partial<Record<InstallFault, { state: GenerationState;
  action: InstallationStepRow['action']; afterCrash: JournalEffect; afterRecovery: JournalEffect }>>;
type CrashPoint = keyof typeof crashJournal;

test('PKG16: killed installer processes resume install, update and removal without losing user data', async () => {
  for (const name of ['REZICS_QA_RUN_ID', 'CONTENT_DATABASE_URL', 'MAIN_S3_ENDPOINT',
    'MAIN_S3_BUCKET', 'MAIN_S3_ACCESS_KEY', 'MAIN_S3_SECRET_KEY']) {
    if (!Bun.env[name]) throw new Error('Run through the isolated QA fault tier');
  }
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  const rootDirectory = join(root, '.temp', `package-process-crash-${randomUUID()}`);
  await mkdir(rootDirectory, { recursive: true });
  try {
    await migrateContent(pool);
    const registry: ArchiveRegistry = { packages: {
      x: { versions: { '1.0.0': {}, '2.0.0': {} } },
      y: { versions: { '1.0.0': {} } },
    }, tamper: new Set(), missing: new Set() };
    const provider = archiveNpmFetcher(registry);
    const namespaces = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
    await namespaces('package/artifact/public/').initialize();
    const npm = new NpmResolutionStore(pool, { fetcher: provider.fetcher });
    const locks = new PackageLockStore(pool, npm, new PackageArtifactStore(pool, namespaces),
      { fetcher: provider.fetcher });
    const store = new PackageInstallationStore(pool, locks, { rootDirectory });
    const principal = randomUUID();
    const lockOf = async (dependencies: Record<string, string>) => {
      const solved = await npm.resolve(principal, `resolve-${randomUUID()}`, npmRegistryRequest({
        name: 'crash', native: false,
        manifest: { name: 'crash-root', version: '1.0.0', dependencies },
        expect: { status: 'solved', correspondence: null, allowedDivergences: [] },
      }));
      const resolution = solved.resolution.resolution.split('/').at(-1)!;
      const locked = await locks.create(principal, `lock-${randomUUID()}`, {
        profile: 'rezics-package-lock-v1', segments: [{ ecosystem: 'npm', resolution,
          scope: { kind: 'process', label: 'node' } }],
      });
      expect((await locks.replay(principal, `replay-${randomUUID()}`, locked.lock.lock)).replay.outcome)
        .toBe('verified');
      return locked.lock.lock;
    };
    const target = `crash-${randomUUID()}`;
    const installation = (await store.createInstallation(principal, `install-${randomUUID()}`, {
      profile: 'rezics-controlled-install-v1', target, environment: { os: 'linux', cpu: 'x64' },
    })).installation.installation;
    const rootOf = join(rootDirectory, 'roots', new Bun.CryptoHasher('sha256').update(target).digest('hex'));
    const plan = async (request: GenerationRequest) => {
      const result = await store.plan(principal, installation, `plan-${randomUUID()}`, request);
      expect(result.generation.state).toBe('planned');
      return result.generation.generation;
    };
    const journalAt = async (generation: string, point: CrashPoint, phase: 'afterCrash' | 'afterRecovery') => {
      const result = await pool.query<JournalEffect>(`SELECT j.event, j.effect
        FROM pkg.installation_journal j JOIN pkg.installation_step s
          ON s.generation_id = j.generation_id AND s.ordinal = j.step_ordinal
        WHERE j.generation_id = $1 AND s.action = $2 ORDER BY j.sequence DESC LIMIT 1`,
      [generation, crashJournal[point].action]);
      expect(result.rows[0]).toEqual(crashJournal[point][phase]);
    };
    const killed = async (generation: string, point: CrashPoint) => {
      const input = join(rootDirectory, `child-${randomUUID()}.json`);
      await writeFile(input, JSON.stringify({ rootDirectory, principal, installation, generation, point }));
      const child = spawn(process.execPath, [childScript, input], { stdio: 'ignore', env: process.env });
      const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' });
      expect((await store.readGeneration(principal, installation, generation))?.state)
        .toBe(crashJournal[point].state);
      await journalAt(generation, point, 'afterCrash');
    };
    const userData = [{ path: 'config/settings.json', kind: 'file' as const }];
    const firstLock = await lockOf({ x: '1.0.0', y: '1.0.0' });
    const first = await plan({ operation: 'install', lock: firstLock, rollbackOf: null,
      expectedGeneration: null, userData, approveHooks: [] });
    await killed(first, 'after-unpack-intent');
    expect((await store.apply(principal, installation, first, async () => true)).generation.state).toBe('active');
    await journalAt(first, 'after-unpack-intent', 'afterRecovery');
    await mkdir(join(rootOf, 'config'), { recursive: true });
    await writeFile(join(rootOf, 'config/settings.json'), '{"theme":"user"}');

    const secondLock = await lockOf({ x: '2.0.0', y: '1.0.0' });
    const second = await plan({ operation: 'update', lock: secondLock, rollbackOf: null,
      expectedGeneration: first, userData, approveHooks: [] });
    await killed(second, 'before-activation-commit');
    expect((await store.apply(principal, installation, second, async () => true)).generation.state).toBe('active');
    await journalAt(second, 'before-activation-commit', 'afterRecovery');
    expect(await readFile(join(rootOf, 'node_modules/x/index.js'), 'utf8')).toContain('x@2.0.0');
    expect(await readFile(join(rootOf, 'config/settings.json'), 'utf8')).toBe('{"theme":"user"}');

    const removal = await plan({ operation: 'remove', lock: null, rollbackOf: null,
      expectedGeneration: second, userData: [], approveHooks: [] });
    await killed(removal, 'mid-remove');
    expect((await store.apply(principal, installation, removal, async () => true)).generation.state).toBe('active');
    await journalAt(removal, 'mid-remove', 'afterRecovery');
    expect((await store.read(principal, installation))?.state).toBe('removed');
    expect(await readFile(join(rootOf, 'config/settings.json'), 'utf8')).toBe('{"theme":"user"}');
    await expect(readlink(join(rootOf, 'node_modules/x'))).rejects.toThrow();
    await expect(readlink(join(rootOf, 'node_modules/y'))).rejects.toThrow();
    const journals = await pool.query<{ generation_id: string; count: string }>(`SELECT generation_id,
      count(*)::text FROM pkg.installation_journal WHERE generation_id = ANY($1::uuid[])
      GROUP BY generation_id`, [[first, second, removal]]);
    expect(journals.rows).toHaveLength(3);
  } finally {
    await pool.end();
  }
}, 90_000);

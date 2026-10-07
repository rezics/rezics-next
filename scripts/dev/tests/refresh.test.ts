import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { acquireHeavy } from '../../goal/goalctl.ts';
import { appEnvironment, readEnv } from '../config.ts';
import { activeBackend,
  activateBackend,
  backendCommand,
  backendExecutable,
  ensureBackend,
  stageBackend,
  storageBackend,
  AppHostResourceLost, assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  type RefreshActions, type RefreshInputs } from '../refresh.ts';
import { inspectRefresh, lostRefreshResources, printRefreshPlan, refreshAspireOutput,
  refreshHeavyLockHeld, refreshIsCurrent, refreshProcessAlive, refreshStorageDefinitionChanged, RefreshStorageBackup, rehearseRefreshMigrations,
  refreshSharedStack, refreshRecoveryCommitted } from '../refresh-stack.ts';
import { inspectOfficialZoneApprovals } from '../seed/official-zones-step.ts';
import { officialPackageSlugs, officialSourceDigest } from '../seed/official-theme-step.ts';
import { officialTheme } from '../seed/official-plan.ts';
import { parseOptions } from '../seed/cli.ts';
import { stableId } from '../seed/state.ts';

const root = resolve(import.meta.dir, '../../..');
const current: RefreshInputs = { revision: 'committed-main', previousRevision: 'committed-main',
  imagePresent: true, storageChanged: false, pendingMigrations: [], modelCurrent: true, statementCurrent: true, membershipCurrent: true,
  unhealthyResources: [], environmentChanges: [], appHostChanged: false, lostResources: [], zoneApprovals: [] };

describe('pinned shared backend', () => {
  function repository() {
    const dir = mkdtempSync(join(root, '.temp/pinned-backend-'));
    mkdirSync(join(dir, '.temp/stack/rezics-dev'), { recursive: true });
    mkdirSync(join(dir, 'services/main/src'), { recursive: true });
    mkdirSync(join(dir, 'scripts/dev'), { recursive: true });
    cpSync(join(root, 'scripts/dev/refresh.ts'), join(dir, 'scripts/dev/refresh.ts'));
    cpSync(
      join(root, 'scripts/dev/refresh.ts'),
      join(dir, '.temp/stack/rezics-dev/backend-gate.ts'),
    );
    writeFileSync(join(dir, '.gitignore'), '.temp/\nnode_modules/\ngenerated/\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"backend-probe","private":true}');
    writeFileSync(join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    writeFileSync(join(dir, 'yarn.lock'), 'initial-dependencies');
    writeFileSync(
      join(dir, 'Taskfile.yml'),
      `version: '3'
tasks:
  install:
    cmds:
      - mkdir -p node_modules
      - cp yarn.lock node_modules/dependency-version
  gen:
    cmds:
      - mkdir -p generated
      - git rev-parse HEAD > generated/revision
`,
    );
    writeFileSync(join(dir, 'services/main/src/telemetry.ts'), 'export {};');
    writeFileSync(
      join(dir, 'services/main/src/index.ts'),
      `
import { Elysia } from 'elysia';
const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
const app = new Elysia().get('/health/ready', async () => ({ revision,
  generated: (await Bun.file('generated/revision').text()).trim() }))
  .get('/', () => ({ revision })).post('/', () => ({ revision }))
  .listen({ hostname: '127.0.0.1', port: 0 });
console.log(JSON.stringify({ revision, url: app.server!.url.toString() }));
`,
    );
    backendCommand(dir, 'git', ['init', '-b', 'main']);
    backendCommand(dir, 'git', ['config', 'user.email', 'probe@example.invalid']);
    backendCommand(dir, 'git', ['config', 'user.name', 'Backend probe']);
    backendCommand(dir, 'git', ['add', '.']);
    backendCommand(dir, 'git', ['commit', '-m', 'Initial backend']);
    return {
      dir,
      stack: join(dir, '.temp/stack/rezics-dev'),
      revision: backendCommand(dir, 'git', ['rev-parse', 'HEAD']),
    };
  }

  async function start(dir: string, stack: string) {
    const command = backendExecutable(
      'main',
      stack,
      './services/main/src/telemetry.ts',
      'services/main/src/index.ts',
    );
    const child = Bun.spawn([command.executable, ...command.args], {
      cwd: dir,
      env: { ...process.env, REZICS_BACKEND_STACK: stack },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    if (!value) throw new Error(`Backend probe exited: ${await new Response(child.stderr).text()}`);
    const { url, revision } = JSON.parse(new TextDecoder().decode(value)) as {
      url: string;
      revision: string;
    };
    return {
      url,
      revision,
      stop: async () => {
        child.kill();
        await child.exited;
      },
    };
  }

  test('a no-op main commit holds the serving revision until a code-only refresh switches and restarts', async () => {
    const { dir, stack, revision } = repository();
    let backend: Awaited<ReturnType<typeof start>> | undefined;
    try {
      activateBackend(stack, stageBackend(dir, stack, revision));
      backend = await start(dir, stack);
      backendCommand(dir, 'git', ['commit', '--allow-empty', '-m', 'No-op merge']);
      const target = backendCommand(dir, 'git', ['rev-parse', 'HEAD']);
      expect(target).not.toBe(revision);
      expect((await (await fetch(backend.url)).json()).revision).toBe(revision);
      expect(backendCommand(activeBackend(stack)!, 'git', ['rev-parse', 'HEAD'])).toBe(revision);
      const started = performance.now();
      const calls: string[] = [];
      const candidate = stageBackend(dir, stack, target, (cwd, executable, args) => {
        calls.push(`${executable} ${args[0]}`);
        return backendCommand(cwd, executable, args);
      });
      const operations = actions([]);
      operations.stopWriters = async () => {
        await backend!.stop();
        backend = undefined;
      };
      operations.prepareStorage = async () => {
        throw new Error('Code-only refresh must skip storage');
      };
      operations.alignModel = async () => {
        throw new Error('Code-only refresh must skip model alignment');
      };
      operations.snapshotStorage = async () => {
        throw new Error('Code-only refresh must skip snapshots');
      };
      operations.switchBackend = async () => {
        writeFileSync(
          join(stack, 'refresh-pending'),
          JSON.stringify({ token: 'private-refresh-token', pid: process.pid }),
        );
        activateBackend(stack, candidate);
      };
      operations.restartResources = async () => {
        backend = await start(dir, stack);
      };
      operations.waitReady = async () => {
        expect((await fetch(backend!.url, { method: 'POST' })).status).toBe(503);
        expect(await (await fetch(new URL('/health/ready', backend!.url))).json()).toEqual({
          revision: target,
          generated: target,
        });
        expect(
          (
            await fetch(backend!.url, {
              method: 'POST',
              headers: { 'x-rezics-refresh': 'private-refresh-token' },
            })
          ).status,
        ).toBe(200);
      };
      operations.recordSuccess = async () => {
        writeFileSync(join(stack, 'refresh.json'), JSON.stringify({ revision: target }));
        rmSync(join(stack, 'refresh-pending'));
      };
      const plan = refreshPlan({ ...current, revision: target, previousRevision: revision });
      expect(plan.steps).toEqual([
        'stop-writers',
        'switch-backend',
        'restart-resources',
        'wait-ready',
        'approve-zones',
        'record-success',
      ]);
      await executeRefresh(plan, operations);
      expect(calls).toContain('task gen');
      expect(calls).not.toContain('task install');
      expect(backend!.revision).toBe(target);
      expect((await fetch(backend!.url, { method: 'POST' })).status).toBe(200);
      expect(JSON.parse(readFileSync(join(stack, 'refresh.json'), 'utf8')).revision).toBe(target);
      const durationMs = Math.round(performance.now() - started);
      writeFileSync(
        join(root, '.temp/pinned-backend-probe.json'),
        JSON.stringify({
          durationMs,
          previousRevision: revision,
          revision: target,
          mode: 'Elysia on random ports; stub dependency/generation tasks',
        }),
      );
      console.log(
        `Pinned backend no-op refresh probe: ${durationMs} ms (checkout, dependency copy, generation, restart, ready)`,
      );
    } finally {
      await backend?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('failed postcommit model alignment restores the old graph and restarts the previous executable', async () => {
    const { dir, stack, revision } = repository();
    let backend: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const previous = stageBackend(dir, stack, revision);
      activateBackend(stack, previous);
      backend = await start(dir, stack);
      backendCommand(dir, 'git', ['commit', '--allow-empty', '-m', 'New model']);
      const target = backendCommand(dir, 'git', ['rev-parse', 'HEAD']);
      stageBackend(dir, stack, target);
      let model = revision;
      let snapshot = '';
      const events: string[] = [];
      const operations = actions(events);
      operations.stopWriters = async () => {
        await backend!.stop();
        backend = undefined;
      };
      operations.snapshotStorage = async () => {
        snapshot = model;
      };
      operations.alignModel = async () => {
        model = target;
        throw new Error('Audit failed after model head committed');
      };
      operations.rollbackPrevious = async () => {
        model = snapshot;
        activateBackend(stack, previous);
        backend = await start(dir, stack);
      };
      await expect(
        executeRefresh(
          refreshPlan({
            ...current,
            revision: target,
            previousRevision: revision,
            modelCurrent: false,
          }),
          operations,
        ),
      ).rejects.toThrow('Audit failed after model head committed');
      expect(model).toBe(revision);
      expect((await (await fetch(backend!.url)).json()).revision).toBe(revision);
      expect(events).not.toContain('recordSuccess');
    } finally {
      await backend?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('pinned artifacts share canonical stack paths and carry only the existing model audit identity', () => {
    const { dir, stack, revision } = repository();
    try {
      mkdirSync(join(dir, '.temp/datasets'), { recursive: true });
      writeFileSync(join(dir, '.temp/datasets/administrator-abcdef.json'), '{"id":"operator"}', {
        mode: 0o600,
      });
      writeFileSync(join(dir, '.temp/datasets/unrelated.json'), 'not an identity');
      const candidate = stageBackend(dir, stack, revision);
      const env = { MAIN_PORT: '3001', ACCOUNT_PORT: '3002' };
      expect(appEnvironment(env, join(candidate, '.temp/stack/rezics-dev'))).toEqual(
        appEnvironment(env, stack),
      );
      expect(
        readFileSync(join(candidate, '.temp/datasets/administrator-abcdef.json'), 'utf8'),
      ).toBe('{"id":"operator"}');
      expect(existsSync(join(candidate, '.temp/datasets/unrelated.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('changed lockfile installs separately and a generation failure cannot change the active checkout', () => {
    const { dir, stack, revision } = repository();
    try {
      const previous = stageBackend(dir, stack, revision);
      activateBackend(stack, previous);
      writeFileSync(join(dir, 'yarn.lock'), 'new-dependencies');
      backendCommand(dir, 'git', ['add', 'yarn.lock']);
      backendCommand(dir, 'git', ['commit', '-m', 'Dependencies changed']);
      const target = backendCommand(dir, 'git', ['rev-parse', 'HEAD']);
      const calls: string[] = [];
      expect(() =>
        stageBackend(dir, stack, target, (cwd, executable, args) => {
          calls.push(`${executable} ${args[0]}`);
          if (executable === 'task' && args[0] === 'gen') throw new Error('Generation failed');
          return backendCommand(cwd, executable, args);
        }),
      ).toThrow('Generation failed');
      expect(calls).toContain('task install');
      expect(activeBackend(stack)).toBe(previous);
      expect(readFileSync(join(previous, 'node_modules/dependency-version'), 'utf8')).toBe(
        'initial-dependencies',
      );
      const candidate = stageBackend(dir, stack, target);
      expect(readFileSync(join(candidate, 'node_modules/dependency-version'), 'utf8')).toBe(
        'new-dependencies',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('worktree modes retain watch behavior and the shared wrapper rereads its pointer on restart', () => {
    for (const mode of ['frontend', 'backend']) {
      expect(
        backendExecutable(mode, 'stack', 'telemetry', 'services/main/src/index.ts').args,
      ).toContain('--watch');
      expect(
        backendExecutable(mode, 'stack', 'telemetry', 'services/main/src/relay.ts').args,
      ).not.toContain('--watch');
    }
    expect(
      backendExecutable('main', 'stack', 'telemetry', 'services/main/src/index.ts').args,
    ).not.toContain('--watch');
  });

  test('AppHost startup selects the last successful revision even when the active pointer was advanced', () => {
    const { dir, stack, revision } = repository();
    try {
      const previous = stageBackend(dir, stack, revision);
      activateBackend(stack, previous);
      writeFileSync(join(stack, 'refresh.json'), JSON.stringify({ revision }));
      backendCommand(dir, 'git', ['commit', '--allow-empty', '-m', 'Unrecorded candidate']);
      const candidate = stageBackend(dir, stack, backendCommand(dir, 'git', ['rev-parse', 'HEAD']));
      activateBackend(stack, candidate);
      ensureBackend(dir, stack);
      expect(activeBackend(stack)).toBe(previous);
      mkdirSync(join(stack, 'refresh-recovery'));
      expect(() => ensureBackend(dir, stack)).toThrow('Retained storage recovery snapshot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a target frozen before a later main commit stays the recorded and serving revision', async () => {
    const events: string[] = [];
    let head = 'frozen-target';
    let checkpoint = 'previous';
    const target = head;
    const operations = actions(events);
    operations.restartResources = async () => {
      head = 'later-main';
    };
    operations.recordSuccess = async () => {
      checkpoint = target;
    };
    await executeRefresh(refreshPlan({ ...current, revision: target }), operations);
    expect(head).toBe('later-main');
    expect(checkpoint).toBe(target);
  });

  for (const phase of ['committed', 'restored'] as const) {
    test(`${phase} cleanup recovery preserves writes accepted after publication, even at the same revision`, async () => {
      const { dir, stack, revision } = repository();
      try {
        const backend = stageBackend(dir, stack, revision);
        activateBackend(stack, backend);
        const before = {
          revision,
          appHostHash: 'hash',
          appHostSession: 'session',
          refreshId: 'before',
        };
        const checkpoint = { ...before, refreshId: phase === 'committed' ? 'after' : 'before' };
        writeFileSync(join(stack, 'refresh.json'), JSON.stringify(checkpoint));
        const recovery = join(stack, 'refresh-recovery');
        mkdirSync(recovery);
        writeFileSync(
          join(recovery, 'snapshot.json'),
          JSON.stringify({ previous: backend, checkpoint: before }),
        );
        writeFileSync(join(recovery, 'postgres.tar'), 'obsolete owner snapshot');
        writeFileSync(join(stack, 'owner-state'), 'newly accepted write');
        if (phase === 'restored')
          writeFileSync(
            join(stack, 'refresh-pending'),
            JSON.stringify({
              backend,
              storage: backend,
              checkpoint: before,
              refreshId: 'failed-attempt',
              phase,
              restartRequired: false,
            }),
          );
        // The stub has no dev:stop task: trying to rewind would fail this test
        // before any Docker command can run.
        await refreshSharedStack(dir, ['--recover']);
        expect(readFileSync(join(stack, 'owner-state'), 'utf8')).toBe('newly accepted write');
        expect(JSON.parse(readFileSync(join(stack, 'refresh.json'), 'utf8'))).toEqual(checkpoint);
        expect(existsSync(recovery)).toBe(false);
        expect(existsSync(join(stack, 'refresh-pending'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('the checkpoint commit boundary distinguishes a same-revision maintenance refresh', () => {
    expect(refreshRecoveryCommitted({ refreshId: 'new' }, { refreshId: 'old' })).toBe(true);
    expect(refreshRecoveryCommitted({ refreshId: 'old' }, { refreshId: 'old' })).toBe(false);
    expect(refreshRecoveryCommitted(null, null)).toBe(false);
  });

  test('an interrupted code-only refresh restores its previous executable and keeps current owner data', async () => {
    const { dir, stack, revision } = repository();
    try {
      const previous = stageBackend(dir, stack, revision);
      activateBackend(stack, previous);
      const before = {
        revision,
        appHostHash: 'hash',
        appHostSession: 'session',
        refreshId: 'before',
      };
      writeFileSync(join(stack, 'refresh.json'), JSON.stringify(before));
      const facade = join(dir, 'Taskfile.yml');
      writeFileSync(
        facade,
        `${readFileSync(facade, 'utf8')}
  dev:stop:
    cmds:
      - touch .temp/stopped
  dev:
    cmds:
      - touch .temp/started
`,
      );
      backendCommand(dir, 'git', ['add', 'Taskfile.yml']);
      backendCommand(dir, 'git', ['commit', '-m', 'Stub lifecycle commands']);
      const candidate = stageBackend(dir, stack, backendCommand(dir, 'git', ['rev-parse', 'HEAD']));
      activateBackend(stack, candidate);
      writeFileSync(
        join(stack, 'refresh-pending'),
        JSON.stringify({
          phase: 'preparing',
          backend: previous,
          storage: previous,
          checkpoint: before,
          refreshId: 'interrupted',
        }),
      );
      writeFileSync(join(stack, 'owner-state'), 'current owner data');
      await refreshSharedStack(dir, ['--recover']);
      expect(activeBackend(stack)).toBe(previous);
      expect(readFileSync(join(stack, 'owner-state'), 'utf8')).toBe('current owner data');
      expect(existsSync(join(dir, '.temp/stopped'))).toBe(true);
      expect(existsSync(join(dir, '.temp/started'))).toBe(true);
      expect(existsSync(join(stack, 'refresh-pending'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('refresh storage recovery', () => {
  test('code-only revisions retain installed Compose hashes despite different absolute checkout paths', () => {
    const dir = mkdtempSync(join(root, '.temp/refresh-compose-'));
    const previous = join(dir, 'previous');
    const target = join(dir, 'target');
    const stack = join(dir, 'stack');
    mkdirSync(stack);
    for (const checkout of [previous, target]) {
      mkdirSync(join(checkout, 'infra'), { recursive: true });
      cpSync(join(root, 'infra/dev'), join(checkout, 'infra/dev'), { recursive: true });
    }
    const env = join(dir, 'compose.env');
    writeFileSync(
      env,
      [
        'POSTGRES_PASSWORD',
        'REZICS_ACCOUNT_PASSWORD',
        'REZICS_ACCESS_PASSWORD',
        'REZICS_CONTENT_PASSWORD',
        'REZICS_RELAY_PASSWORD',
        'RUSTFS_ACCESS_KEY',
        'RUSTFS_SECRET_KEY',
        'FUSEKI_MAINTENANCE_TOKEN',
        'FUSEKI_COMMAND_TOKEN',
        'FUSEKI_TITLE_ADMISSION_KEY',
      ]
        .map((name) => `${name}=probe-only`)
        .join('\n'),
    );
    const hashes = (checkout: string) =>
      backendCommand(checkout, 'docker', [
        'compose',
        '--env-file',
        env,
        '-f',
        join(checkout, 'infra/dev/compose.yaml'),
        '--project-name',
        'pinned-probe',
        'config',
        '--hash',
        '*',
      ]);
    try {
      const installed = hashes(previous);
      expect(hashes(target)).not.toBe(installed);
      activateBackend(stack, previous, 'storage-backend');
      activateBackend(stack, target);
      expect(hashes(storageBackend(stack)!)).toBe(installed);
      expect(refreshStorageDefinitionChanged(target, storageBackend(stack)!)).toBe(false);
      writeFileSync(join(target, 'infra/dev/toxiproxy/config.json'), '[]');
      expect(refreshStorageDefinitionChanged(target, storageBackend(stack)!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('postcommit alignment failure restores both stopped owner volumes and private environment', () => {
    const dir = mkdtempSync(join(root, '.temp/refresh-snapshot-'));
    const stack = join(dir, '.temp/stack/rezics-dev');
    mkdirSync(stack, { recursive: true });
    writeFileSync(join(stack, 'dev.env'), 'MODEL=previous\n');
    const previous = join(stack, 'backend-revisions', 'a'.repeat(40));
    const backend = join(stack, 'backend-revisions', 'b'.repeat(40));
    mkdirSync(previous, { recursive: true });
    mkdirSync(backend, { recursive: true });
    activateBackend(stack, backend);
    const volumes: Record<string, string> = { postgres: 'previous-sql', fuseki: 'previous-model' };
    const snapshots: Record<string, string> = {};
    const events: string[] = [];
    const backup = new RefreshStorageBackup(
      previous,
      dir,
      (_cwd, _executable, args) => {
        if (args[0] === 'inspect') {
          const service = args[1]!;
          return JSON.stringify([
            {
              Image: 'pinned-postgres',
              Mounts: [
                {
                  Type: 'volume',
                  Name: service,
                  Destination: service === 'postgres' ? '/var/lib/postgresql' : '/fuseki/databases',
                },
              ],
            },
          ]);
        }
        const service = args
          .find((arg) => arg.startsWith('type=volume,source='))!
          .split(',')[1]!
          .slice('source='.length);
        if (args.at(-1)!.includes('-cpf')) {
          snapshots[service] = volumes[service]!;
          events.push(`snapshot:${service}`);
        } else {
          volumes[service] = snapshots[service]!;
          events.push(`restore:${service}`);
        }
        return '';
      },
      (_cwd, args) => {
        if (args[0] === 'ps') return args[2]!;
        events.push(args.join(' '));
        return '';
      },
    );
    try {
      backup.capture();
      const reloaded = new RefreshStorageBackup(previous, dir);
      expect(reloaded.load().backend).toBe(backend);
      volumes.postgres = 'partially-migrated-sql';
      volumes.fuseki = 'committed-new-model';
      writeFileSync(join(stack, 'dev.env'), 'MODEL=new\n');
      backup.restore();
      expect(volumes).toEqual({ postgres: 'previous-sql', fuseki: 'previous-model' });
      expect(readFileSync(join(stack, 'dev.env'), 'utf8')).toBe('MODEL=previous\n');
      expect(events).toEqual([
        'stop postgres fuseki',
        'snapshot:postgres',
        'snapshot:fuseki',
        'up -d --wait postgres fuseki',
        'stop postgres fuseki',
        'restore:postgres',
        'restore:fuseki',
        'up -d --wait',
      ]);
      backup.discard();
      expect(existsSync(join(stack, 'refresh-recovery'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('capture refuses a retained recovery set and cannot discard it during rollback', () => {
    const dir = mkdtempSync(join(root, '.temp/refresh-retained-'));
    const recovery = join(dir, '.temp/stack/rezics-dev/refresh-recovery');
    mkdirSync(recovery, { recursive: true });
    writeFileSync(join(recovery, 'snapshot.json'), 'retained');
    try {
      const backup = new RefreshStorageBackup(dir, dir);
      expect(() => backup.capture()).toThrow('retained');
      backup.restore();
      backup.discard();
      expect(readFileSync(join(recovery, 'snapshot.json'), 'utf8')).toBe('retained');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shared stack refresh planning', () => {
  test('shared refresh takes the next heavy turn without preempting the holder', async () => {
    const dir = mkdtempSync(join(root, '.temp/refresh-priority-'));
    const lockDir = join(dir, 'heavy');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    writeFileSync(join(lockDir, 'marker'), 'current holder');
    const resumes: Array<() => void> = [];
    const sleep = () => new Promise<void>(resolve => { resumes.push(resolve); });
    const options = { lockDir, bindExit: false, sleep };
    let ordinaryServed = false;
    let refreshServed = false;
    const ordinary = acquireHeavy(['task', 'qa'], options).then(release => { ordinaryServed = true; return release; });
    const refresh = acquireHeavy(['task', 'dev:refresh'], options).then(release => { refreshServed = true; return release; });
    try {
      expect(resumes).toHaveLength(2);
      expect(ordinaryServed).toBe(false);
      expect(refreshServed).toBe(false);
      expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('current holder');
      rmSync(lockDir, { recursive: true });
      // The older ordinary waiter polls first, but leaves the free lock for refresh.
      resumes.shift()!();
      await Bun.sleep(0);
      expect(ordinaryServed).toBe(false);
      resumes.shift()!();
      const releaseRefresh = await refresh;
      expect(refreshServed).toBe(true);
      expect(ordinaryServed).toBe(false);
      releaseRefresh();
      resumes.shift()!();
      (await ordinary)();
      expect(ordinaryServed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);

  test('a second successful run has no mutating steps', () => {
    expect(refreshPlan(current)).toEqual({ steps: [], blockers: [] });
  });

  test('a missing pinned image is built before stopped-writer storage and model maintenance', () => {
    expect(refreshPlan({ ...current, imagePresent: false, storageChanged: true,
      pendingMigrations: ['access/new.sql'], modelCurrent: false }).steps).toEqual([
      'build-image', 'rehearse-migrations', 'stop-writers', 'snapshot-storage',
      'prepare-storage', 'align-model',
      'switch-backend',
      'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
    ]);
  });

  for (const [reason, changes] of [
    ['container drift', { storageChanged: true }],
    ['pending Access migration', { pendingMigrations: ['access/new.sql'] }],
    ['incomplete catalogue Statement upgrade', { statementCurrent: false }],
  ] as const) {
    test(`${reason} prepares storage and aligns the model before restarting`, () => {
      expect(refreshPlan({ ...current, ...changes }).steps).toEqual([
        ...('pendingMigrations' in changes ? ['rehearse-migrations'] as const : []),
        'stop-writers', 'snapshot-storage',
        'prepare-storage', 'align-model',
        'switch-backend', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
      ]);
    });
  }

  test('legacy ordered membership requires stopped-writer owner preparation even at the recorded revision', async () => {
    const plan = refreshPlan({ ...current, membershipCurrent: false });
    expect(plan.steps).toEqual(['stop-writers', 'snapshot-storage',
      'prepare-storage', 'align-model',
      'switch-backend',
      'restart-resources', 'wait-ready', 'approve-zones', 'record-success']);
    const events: string[] = [];
    await expect(executeRefresh(plan, actions(events, 'prepareStorage'))).rejects.toThrow('failed prepareStorage');
    expect(events).toEqual(['stopWriters', 'snapshotStorage',
      'prepareStorage',
      'rollbackPrevious',
    ]);
    await executeRefresh(plan, actions([]));
    expect(refreshPlan(current).steps).toEqual([]);
  });

  test('a stale model generation is aligned without unnecessary storage work', () => {
    expect(refreshPlan({ ...current, modelCurrent: false }).steps).toEqual([
      'stop-writers', 'snapshot-storage',
      'align-model',
      'switch-backend', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
    ]);
  });

  test('a failed relay is recovered even at an already recorded revision', () => {
    expect(refreshPlan({ ...current, unhealthyResources: ['main-relay'] }).steps).toEqual([
      'stop-writers', 'switch-backend', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
    ]);
  });

  test('environment drift and changed topology require an AppHost restart', () => {
    const plan = refreshPlan({ ...current, environmentChanges: ['NEW_TOKEN'], appHostChanged: true });
    expect(plan.blockers).toHaveLength(2);
    expect(plan.blockers.join('\n')).toContain('task dev:stop, then task dev');
    expect(plan.blockers.join('\n')).toContain('NEW_TOKEN');
  });

  test('environment comparison ignores ordering and reports only changed names', () => {
    expect(changedEnvironment({ A: '1', PASSWORD: 'old-secret' }, { PASSWORD: 'new-secret', B: '2' }))
      .toEqual(['A', 'B', 'PASSWORD']);
    expect(changedEnvironment({ A: '1', B: '2' }, { B: '2', A: '1' })).toEqual([]);
  });

  test('lost AppHost resources block refresh before writers are stopped', async () => {
    const events: string[] = [];
    const plan = refreshPlan({ ...current, lostResources: ['main-relay'], revision: 'merged' });
    expect(plan.blockers.join('\n')).toContain('main-relay');
    expect(plan.blockers.join('\n')).toContain('task dev:stop, then task dev');
    await expect(executeRefresh(plan, actions(events))).rejects.toThrow('AppHost restart required');
    expect(events).toEqual([]);
  });

  test('only changed Zone approvals require readiness and approval without stopping writers', () => {
    expect(refreshPlan({ ...current, zoneApprovals: [{ slug: 'franchise-wiki', digest: 'new', approvedDigest: 'old' }] }))
      .toEqual({ steps: ['wait-ready', 'approve-zones', 'record-success'], blockers: [] });
  });
});

function actions(events: string[], fail?: keyof RefreshActions): RefreshActions {
  const step = (name: keyof RefreshActions) => async () => {
    events.push(name);
    if (name === fail) throw new Error(`failed ${name}`);
  };
  return { buildImage: step('buildImage'), rehearseMigrations: step('rehearseMigrations'),
    stopWriters: step('stopWriters'), snapshotStorage: step('snapshotStorage'),
    switchBackend: step('switchBackend'),
    rollbackPrevious: step('rollbackPrevious'),
    prepareStorage: step('prepareStorage'),
    alignModel: step('alignModel'), restartResources: step('restartResources'), waitReady: step('waitReady'),
    approveZones: step('approveZones'), stopAppHost: step('stopAppHost'), recordSuccess: step('recordSuccess') };
}

describe('shared stack refresh execution and guards', () => {
  test('an incomplete Statement upgrade prepares stopped storage and cannot restart on conversion failure', async () => {
    const events: string[] = [];
    await expect(executeRefresh(refreshPlan({...current,statementCurrent: false}),actions(events,'prepareStorage')))
      .rejects.toThrow('failed prepareStorage');
    expect(events).toEqual(['stopWriters','snapshotStorage',
      'prepareStorage',
      'rollbackPrevious',
    ]);
  });
  test('worktrees, other branches and tracked edits are refused', () => {
    expect(() => assertRefreshCheckout(true, 'main', false)).toThrow('never in a worktree');
    expect(() => assertRefreshCheckout(false, 'feature', false)).toThrow('committed main');
    expect(() => assertRefreshCheckout(false, 'main', true)).toThrow('committed main');
    expect(() => assertRefreshCheckout(false, 'main', false)).not.toThrow();
  });

  test('blocked preflight makes no changes', async () => {
    const events: string[] = [];
    await expect(executeRefresh(refreshPlan({ ...current, revision: 'merged', environmentChanges: ['NEW_TOKEN'] }),
      actions(events))).rejects.toThrow('task dev:stop');
    expect(events).toEqual([]);
  });

  test('success is recorded only after ordered maintenance and readiness', async () => {
    const events: string[] = [];
    await executeRefresh(refreshPlan({ ...current, imagePresent: false }), actions(events));
    expect(events).toEqual(['buildImage', 'stopWriters', 'snapshotStorage',
      'prepareStorage', 'alignModel',
      'switchBackend',
      'restartResources', 'waitReady', 'approveZones', 'recordSuccess']);
    events.length = 0;
    await executeRefresh(refreshPlan(current), actions(events));
    expect(events).toEqual([]);
  });

  test('a failing pending migration aborts before stopping writers and reports its error', async () => {
    const events: string[] = [];
    const plan = refreshPlan({ ...current, pendingMigrations: ['services/main/migrations/access/broken.sql'] });
    await expect(executeRefresh(plan, actions(events, 'rehearseMigrations')))
      .rejects.toThrow('failed rehearseMigrations');
    expect(events).toEqual(['rehearseMigrations']);
    const retry: string[] = [];
    await executeRefresh(plan, actions(retry));
    expect(retry).toEqual(['rehearseMigrations', 'stopWriters', 'snapshotStorage',
      'prepareStorage', 'alignModel',
      'switchBackend',
      'restartResources', 'waitReady', 'approveZones', 'recordSuccess']);
  });

  for (const failure of ['prepareStorage', 'alignModel', 'switchBackend', 'restartResources', 'waitReady', 'approveZones'] as const) {
    test(`${failure} failure records no successful refresh and can be retried`, async () => {
      const events: string[] = [];
      const plan = refreshPlan({ ...current, revision: 'merged' , storageChanged: true });
      await expect(executeRefresh(plan, actions(events, failure))).rejects.toThrow(`failed ${failure}`);
      expect(events).not.toContain('recordSuccess');
      const retry: string[] = [];
      await executeRefresh(plan, actions(retry));
      expect(retry.at(-1)).toBe('recordSuccess');
    });
  }

  for (const failure of ['stopWriters', 'switchBackend',
    'restartResources', 'waitReady',
  ] as const) {
    test(`lost executable during ${failure} stops the AppHost and records no checkpoint`, async () => {
      const events: string[] = [];
      const operations = actions(events);
      operations[failure] = async () => { events.push(failure); throw new AppHostResourceLost('main-relay', failure); };
      await expect(executeRefresh(refreshPlan({ ...current, revision: 'merged' }), operations))
        .rejects.toThrow('This AppHost was stopped; data volumes were retained');
      expect(events.at(-1)).toBe('stopAppHost');
      expect(events).not.toContain('recordSuccess');
      expect(events).not.toContain('approveZones');
    });
  }

  test('failed AppHost shutdown reports the required recovery instead of claiming a safe stop', async () => {
    const operations = actions([], 'stopAppHost');
    operations.stopWriters = async () => { throw new AppHostResourceLost('main', 'stop'); };
    await expect(executeRefresh(refreshPlan({ ...current, revision: 'merged' }), operations))
      .rejects.toThrow('Automatic AppHost shutdown failed');
  });

  test('resource inspection distinguishes unhealthy live processes from stale Running state', () => {
    const resources = { account: { name: 'account', state: 'Running', properties: { 'executable.pid': 11 } },
      main: { name: 'main', state: 'Running', healthStatus: 'Unhealthy', properties: { 'executable.pid': 12 } },
      'main-relay': { name: 'main-relay', state: 'Running', properties: { 'executable.pid': 13 } } };
    expect(lostRefreshResources(resources, pid => pid !== 13)).toEqual(['main-relay']);
    expect(lostRefreshResources({ ...resources, 'main-relay': undefined }, () => true)).toEqual(['main-relay']);
    expect(lostRefreshResources({ ...resources, 'main-relay': { name: 'main-relay', state: 'Exited' } }, () => true)).toEqual([]);
    expect(lostRefreshResources({ ...resources, 'main-relay': { name: 'main-relay', state: 'Running' } }, pid => pid > 0)).toEqual(['main-relay']);
    expect(refreshProcessAlive(process.pid)).toBe(true);
    expect(refreshProcessAlive(-1)).toBe(false);
    expect(refreshProcessAlive(99999999)).toBe(false);
  });

  for (const [args, status, stderr] of [
    [['resource', 'main-relay', 'stop'], 17, 'DCP NotFound: executable missing secret-value'],
    [['resource', 'main-relay', 'restart'], 16, ''],
    [['wait', 'main-relay'], 16, ''],
    [['wait', 'main-relay'], 1, 'resource not found'],
  ] as const) {
    test(`Aspire ${args.join(' ')} exit ${status} retains resource loss without diagnostics`, () => {
      expect(() => refreshAspireOutput([...args], { status, stdout: '', stderr })).toThrow(AppHostResourceLost);
      try { refreshAspireOutput([...args], { status, stdout: '', stderr }); }
      catch (error) { expect((error as Error).message).not.toContain('secret-value'); }
    });
  }

  test('other Aspire errors remain ordinary failures without exposing output', () => {
    expect(() => refreshAspireOutput(['resource', 'main', 'stop'], { status: 17, stdout: '', stderr: 'secret-value' }))
      .toThrow('Aspire resource failed (exit 17)');
    expect(refreshAspireOutput(['describe'], { status: 0, stdout: ' {}\n', stderr: '' })).toBe('{}');
  });

  test('heavy lock inspection detects live owners and the creation race without modifying stale locks', () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const dir = mkdtempSync(join(root, '.temp/refresh-lock-'));
    const lock = join(dir, 'heavy');
    try {
      expect(refreshHeavyLockHeld(lock)).toBe(false);
      mkdirSync(lock);
      expect(refreshHeavyLockHeld(lock, () => false)).toBe(true);
      writeFileSync(join(lock, 'pid'), '99999999');
      const old = new Date(Date.now() - 20_000);
      utimesSync(lock, old, old);
      expect(refreshHeavyLockHeld(lock, () => true)).toBe(true);
      expect(refreshHeavyLockHeld(lock, () => false)).toBe(false);
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('99999999');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(process.env.REZICS_REFRESH_SHARED_DRY_RUN !== '1')('dry-run inspects the shared stack without preparation or configuration writes', async () => {
    const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8' });
    if (git.status !== 0) throw new Error('Cannot locate the shared checkout');
    const shared = dirname(git.stdout.trim());
    const stack = join(shared, '.temp/stack/rezics-dev');
    const files = ['compose.env', 'apps.env', 'dev.env'];
    const before = files.map(file => ({ bytes: readFileSync(join(stack, file), 'utf8'), mtime: statSync(join(stack, file)).mtimeMs }));
    try {
      const snapshot = await inspectRefresh(root, shared);
      printRefreshPlan(snapshot);
      expect(snapshot.input.lostResources).toEqual([]);
      expect(snapshot.plan.blockers).toEqual([]);
    } finally {
      files.forEach((file, index) => {
        expect(readFileSync(join(stack, file), 'utf8')).toBe(before[index]!.bytes);
        expect(statSync(join(stack, file)).mtimeMs).toBe(before[index]!.mtime);
      });
    }
  }, 60_000);
});

describe('pending SQL migration rehearsal', () => {
  const env = { ACCESS_DATABASE_URL: 'access-db', MAIN_RELAY_DATABASE_URL: 'relay-db',
    CONTENT_DATABASE_URL: 'content-db', ACCOUNT_DATABASE_URL: 'account-db' };

  function fixture() {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const dir = mkdtempSync(join(root, '.temp/refresh-migrations-'));
    for (const owner of ['services/main/migrations/access', 'services/main/migrations/relay',
      'services/content/migrations', 'services/account/migrations']) mkdirSync(join(dir, owner), { recursive: true });
    const first = 'services/main/migrations/access/001_backfill.sql';
    const second = 'services/main/migrations/access/002_constraint.sql';
    const content = 'services/content/migrations/001_content.sql';
    // sql-relations-allow: access.event -- synthetic migration text for the rehearsal test, never applied to an owner
    writeFileSync(join(dir, first), 'UPDATE access.event SET epoch = 1;');
    writeFileSync(join(dir, second), 'ALTER TABLE access.event ADD CHECK (epoch > 0);');
    // sql-relations-allow: content.event -- synthetic migration text for the rehearsal test, never applied to an owner
    writeFileSync(join(dir, content), 'ALTER TABLE content.event ADD COLUMN epoch bigint;');
    return { dir, first, second, content };
  }

  test('only pending files run in migration order with one rollback per owner database', async () => {
    const { dir, first, second, content } = fixture();
    const events: string[] = [];
    try {
      await rehearseRefreshMigrations(dir, env, [content, second, first], url => ({
        connect: async () => { events.push(`connect:${url}`); },
        query: async sql => { events.push(sql.startsWith('DO $$') ? 'isolate-sequences' : sql); },
        end: async () => { events.push('end'); },
      }));
      expect(events).toEqual(['connect:access-db', 'BEGIN', 'isolate-sequences',
        readFileSync(join(dir, first), 'utf8'),
        readFileSync(join(dir, second), 'utf8'), 'ROLLBACK', 'end',
        'connect:content-db', 'BEGIN', 'isolate-sequences', readFileSync(join(dir, content), 'utf8'), 'ROLLBACK', 'end']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const fails of [false, true]) {
    test(fails ? 'a failing dependent second migration names that file and leaves writers running'
      : 'a second pending migration can consume the first migration before owner rollback', async () => {
      const { dir, first, second } = fixture();
      const events: string[] = [];
      let tableExists = false;
      writeFileSync(join(dir, first), 'CREATE TABLE dependency(value integer CHECK (value > 0));');
      writeFileSync(join(dir, second), `INSERT INTO dependency VALUES (${fails ? -1 : 1});`);
      const operations = actions(events);
      operations.rehearseMigrations = () => rehearseRefreshMigrations(dir, env, [second, first], () => ({
        connect: async () => { events.push('connect'); },
        query: async sql => {
          events.push(sql.startsWith('DO $$') ? 'isolate-sequences' : sql);
          if (sql.startsWith('CREATE TABLE')) tableExists = true;
          if (sql.startsWith('INSERT')) {
            if (!tableExists) throw new Error('relation dependency does not exist');
            if (fails) throw new Error('dependency value violates check constraint');
          }
          if (sql === 'ROLLBACK') tableExists = false;
        },
        end: async () => { events.push('end'); },
      }));
      try {
        const run = executeRefresh(refreshPlan({ ...current, pendingMigrations: [second, first] }), operations);
        if (fails) {
          await expect(run).rejects.toThrow(`Migration rehearsal failed: ${second}: dependency value violates check constraint`);
          expect(events).not.toContain('stopWriters');
          expect(events).not.toContain('recordSuccess');
        } else {
          await run;
          expect(events.indexOf('stopWriters')).toBeGreaterThan(events.indexOf('ROLLBACK'));
          expect(events.at(-1)).toBe('recordSuccess');
        }
        expect(events.slice(0, 7)).toEqual(['connect', 'BEGIN', 'isolate-sequences',
          readFileSync(join(dir, first), 'utf8'), readFileSync(join(dir, second), 'utf8'), 'ROLLBACK', 'end']);
        expect(tableExists).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const diagnostic of ['immutable rows cannot be updated', 'canceling statement due to lock timeout',
    'terminating connection due to transaction timeout']) {
    test(`${diagnostic} rolls back, closes the client and preserves writers`, async () => {
      const { dir, first, second, content } = fixture();
      const events: string[] = [];
      const operations = actions(events);
      operations.rehearseMigrations = () => rehearseRefreshMigrations(dir, env, [first, second, content], url => ({
        connect: async () => { events.push(`connect:${url}`); },
        query: async sql => {
          events.push(sql.startsWith('DO $$') ? 'isolate-sequences' : sql);
          if (sql.startsWith('UPDATE')) throw new Error(diagnostic);
          if (sql === 'ROLLBACK' && diagnostic.includes('transaction timeout')) throw new Error('Connection closed');
        },
        end: async () => { events.push('end'); },
      }));
      try {
        await expect(executeRefresh(refreshPlan({ ...current, pendingMigrations: [first, second, content] }), operations))
          .rejects.toThrow(`Migration rehearsal failed: ${first}: ${diagnostic}. Writers were not stopped`);
        expect(events).toEqual(['connect:access-db', 'BEGIN', 'isolate-sequences',
          readFileSync(join(dir, first), 'utf8'), 'ROLLBACK', 'end']);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('no pending migrations opens no database connections', async () => {
    await rehearseRefreshMigrations(root, env, [], () => { throw new Error('Must not connect'); });
  });

  for (const fails of [false, true]) {
    test.skipIf(process.env.REZICS_REFRESH_SEQUENCE_PROBE !== '1')(`live PostgreSQL dependent migrations ${fails ? 'fail in the second file' : 'pass'} and restore schema, rows and sequences`, async () => {
      const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: root, encoding: 'utf8' });
      if (git.status !== 0) throw new Error('Cannot locate the shared checkout');
      const sharedEnv = readEnv(join(dirname(git.stdout.trim()), '.temp/stack/rezics-dev/dev.env'));
      const { dir, first, second } = fixture();
      const client = new Client({ connectionString: sharedEnv.ACCESS_DATABASE_URL, connectionTimeoutMillis: 5_000,
        lock_timeout: 1_000, statement_timeout: 5_000, options: '-c transaction_timeout=10000' });
      writeFileSync(join(dir, first), 'CREATE TEMP TABLE refresh_probe_dependency(value integer CHECK (value > 0));');
      writeFileSync(join(dir, second), `SELECT nextval('pg_temp.refresh_probe_sequence');
        SELECT setval('pg_temp.refresh_probe_sequence', 900);
        UPDATE refresh_probe_rows SET value = 2;
        INSERT INTO refresh_probe_dependency VALUES (${fails ? -1 : 1});`);
      try {
        const run = rehearseRefreshMigrations(dir, sharedEnv, [second, first], () => ({
          connect: async () => {
            await client.connect();
            await client.query('CREATE TEMP SEQUENCE refresh_probe_sequence START 42');
            await client.query('SELECT nextval(\'pg_temp.refresh_probe_sequence\')');
            await client.query('CREATE TEMP TABLE refresh_probe_rows(value integer)');
            await client.query('INSERT INTO refresh_probe_rows VALUES (1)');
          },
          query: sql => client.query(sql),
          end: async () => {
            try {
              expect((await client.query('SELECT last_value::text, is_called FROM pg_temp.refresh_probe_sequence')).rows)
                .toEqual([{ last_value: '42', is_called: true }]);
              expect((await client.query('SELECT value FROM refresh_probe_rows')).rows).toEqual([{ value: 1 }]);
              expect((await client.query("SELECT to_regclass('pg_temp.refresh_probe_dependency') AS relation")).rows)
                .toEqual([{ relation: null }]);
            } finally { await client.end(); }
          },
        }));
        if (fails) await expect(run).rejects.toThrow(`Migration rehearsal failed: ${second}:`);
        else await run;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);
  }
});

describe('official Zone approval refresh', () => {
  const presentation = (slug: typeof officialPackageSlugs[number], digest: string | null) => Response.json({
    presentation: { official: { theme: officialTheme(slug) } },
    execution: digest ? { state: 'package', packageDigest: digest } : { state: 'fallback', reason: 'expired' },
  });

  test('each installed official package, including franchise-wiki, compares its source against active approval', async () => {
    const requested: string[] = [];
    const changes = await inspectOfficialZoneApprovals(async path => {
      requested.push(path);
      const slug = officialPackageSlugs.find(item => path.includes(stableId(`zone:${item}`)))!;
      return presentation(slug, slug === 'franchise-wiki' ? 'old' : 'current');
    }, async () => 'current');
    expect(requested).toHaveLength(officialPackageSlugs.length);
    expect(changes).toEqual([{ slug: 'franchise-wiki', digest: 'current', approvedDigest: 'old' }]);
  });

  test('missing demo Zones do not create approvals and expired approvals are renewed', async () => {
    const changes = await inspectOfficialZoneApprovals(async path => path.includes(stableId('zone:fiction'))
      ? presentation('fiction', null) : new Response(null, { status: 404 }), async () => 'source');
    expect(changes).toEqual([{ slug: 'fiction', digest: 'source', approvedDigest: null }]);
  });

  test('custom themes are preserved and transient reads cannot be mistaken for absent approvals', async () => {
    expect(await inspectOfficialZoneApprovals(async () => Response.json({ presentation: {}, execution: {} }),
      async () => { throw new Error('custom theme must not be inspected'); })).toEqual([]);
    await expect(inspectOfficialZoneApprovals(async () => new Response(null, { status: 503 }), async () => 'source'))
      .rejects.toThrow('HTTP 503');
  });

  for (const reason of ['revoked', 'globally_disabled']) {
    test(`${reason} theme control is preserved`, async () => {
      await expect(inspectOfficialZoneApprovals(async () => Response.json({
        presentation: { official: { theme: officialTheme('fiction') } }, execution: { state: 'fallback', reason },
      }), async () => 'source')).rejects.toThrow(reason);
    });
  }

  test('approval selection is bounded to known packages and does not expand to other seed steps', () => {
    expect(parseOptions(['--themes-only', '--packages=franchise-wiki,fiction']).packages).toEqual(['franchise-wiki', 'fiction']);
    expect(() => parseOptions(['--packages=fiction'])).toThrow('--themes-only');
    expect(() => parseOptions(['--themes-only', '--packages=unknown'])).toThrow('installed official packages');
    expect(() => parseOptions(['--themes-only', '--packages=fiction,fiction'])).toThrow('installed official packages');
    expect(() => parseOptions(['--themes-only', '--packages=fiction', '--packages=fiction'])).toThrow('installed official packages');
  });

  test('approval comparison uses the same source digest as task zones:digest', async () => {
    const command = spawnSync('task', ['zones:digest', '--', 'franchise-wiki'], { cwd: root, encoding: 'utf8' });
    expect(command.status).toBe(0);
    expect(await officialSourceDigest('franchise-wiki')).toBe(command.stdout.trim());
  });
});

test('a refresh is current only when the serving revision and live state match the target', () => {
  // Even a no-op commit requires explicit refresh before it becomes the serving revision.
  const current = {
    revision: 'new-head', previousRevision: 'old-head', imagePresent: true, storageChanged: false,
    pendingMigrations: [], modelCurrent: true, statementCurrent: true, membershipCurrent: true,
    unhealthyResources: [], environmentChanges: [], appHostChanged: false, lostResources: [], zoneApprovals: [],
  };
  expect(refreshIsCurrent(current)).toBe(false);
  expect(refreshIsCurrent({ ...current, previousRevision: current.revision })).toBe(true);
  expect(refreshIsCurrent({ ...current, pendingMigrations: ['1700_x.sql'] })).toBe(false);
  expect(refreshIsCurrent({ ...current, modelCurrent: false })).toBe(false);
  expect(refreshIsCurrent({ ...current, imagePresent: false })).toBe(false);
  expect(refreshIsCurrent({ ...current, storageChanged: true })).toBe(false);
  expect(refreshIsCurrent({ ...current, unhealthyResources: ['main'] })).toBe(false);
  expect(refreshIsCurrent({ ...current, environmentChanges: ['WEB_OAUTH_CLIENT_ID'] })).toBe(false);
});

import { describe, expect, test } from 'bun:test';
// sql-relations-allow: access.online_probe -- Synthetic index used only by mocked rehearsal clients.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { acquireHeavy, withRecovery } from '../../goal/goalctl.ts';
import { startDevCompose } from '../cli.ts';
import { GiB } from '../../qa/memory-admission.ts';
import { appEnvironment, readEnv } from '../config.ts';
import { activeBackend,
  activateBackend,
  appHostSourceHash,
  backendCommand,
  backendExecutable,
  ensureBackend,
  stageBackend,
  readPendingRefresh,
  linkBackendModelJournal,
  storageBackend,
  AppHostResourceLost, assertRefreshCheckout, changedEnvironment, executeRefresh, refreshPlan,
  type RefreshActions, type RefreshInputs } from '../refresh.ts';
import { inspectRefresh, inspectRefreshAppHost, refreshMembershipCurrent, lostRefreshResources, printRefreshPlan, refreshAspireOutput,
  refreshLifecycleLockHeld, refreshIsCurrent, refreshLoadedEnvironmentChanges, refreshProcessAlive,
  buildRefreshImage, imageBuildBudgetMs,
  refreshStorageDefinitionChanged, rehearseRefreshMigrations, waitRefreshReady} from '../refresh-stack.ts';
import { refreshSharedStack, prepareRefreshStorage, seedRefreshZones, refreshBuildStepLog } from '../refresh-stack.ts';
import { inspectOfficialZoneApprovals } from '../seed/official-zones-step.ts';
import { officialPackageSlugs, officialSourceDigest } from '../seed/official-theme-step.ts';
import { officialTheme } from '../seed/official-plan.ts';
import { parseOptions } from '../seed/cli.ts';
import { stableId } from '../seed/state.ts';
import { sqlMigration } from '../../lib/concurrent-index.ts';

const root = resolve(import.meta.dir, '../../..');
const current: RefreshInputs = { revision: 'committed-main', previousRevision: 'committed-main',
  imagePresent: true, storageChanged: false, pendingMigrations: [], modelCurrent: true, statementCurrent: true, membershipCurrent: true,
  unhealthyResources: [], environmentChanges: [], appHostChanged: false, lostResources: [], zoneApprovals: [] };

describe('pinned shared backend', () => {
  function repository() {
    const dir = mkdtempSync(join(root, '.temp/pinned-backend-'));
    mkdirSync(join(dir, '.temp/stack/rezics-dev'), { recursive: true });
    mkdirSync(join(dir, 'services/main/src'), { recursive: true });
    mkdirSync(join(dir, 'apphost'), { recursive: true });
    writeFileSync(join(dir, 'apphost/apphost.mts'), `export const topology = 'original';`);
    mkdirSync(join(dir, 'scripts/dev'), { recursive: true });
    cpSync(join(root, 'scripts/dev/refresh.ts'), join(dir, 'scripts/dev/refresh.ts'));
    mkdirSync(join(dir, 'scripts/qa'), { recursive: true });
    writeFileSync(join(dir, 'scripts/qa/host-admission.ts'), `
import { appendFileSync, mkdirSync } from 'node:fs';
mkdirSync('.temp', { recursive: true });
appendFileSync('.temp/build-admission', process.argv.slice(2).join(' ') + '\\n');
const split = process.argv.indexOf('--');
process.exit(Bun.spawnSync(process.argv.slice(split + 1), { stdout: 'inherit', stderr: 'inherit' }).exitCode);
`);
    mkdirSync(join(dir, 'scripts/dev/seed'), { recursive: true });
    writeFileSync(join(dir, 'scripts/dev/seed/stack-probe.ts'), `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stack = process.env.REZICS_SEED_STACK_DIRECTORY;
if (!stack) throw new Error('Isolated dev backend is absent');
writeFileSync('.temp/seed-result', JSON.stringify({ stack,
  environment: readFileSync(join(stack, 'dev.env'), 'utf8'), args: process.argv.slice(2) }));
`);
    writeFileSync(join(dir, 'scripts/dev/inspection.ts'), `export const inspection = 'original';`);
    writeFileSync(join(dir, 'scripts/dev/refresh-stack.ts'), `
import { writeFileSync } from 'node:fs';
import { inspection } from './inspection.ts';
import { refreshStagedStack } from '${join(root, 'scripts/dev/refresh-stack.ts')}';
writeFileSync('.temp/inspection-result', JSON.stringify({ inspection, pid: process.pid, cwd: process.cwd() }));
const [, stackRoot, revision, lock, parent] = process.argv.slice(2);
try { await refreshStagedStack(stackRoot!, revision!, lock!, Number(parent)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
`);
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
      - mkdir -p node_modules .temp/stack/rezics-dev
      - cp yarn.lock node_modules/dependency-version
  gen:
    cmds:
      - mkdir -p generated
      - git rev-parse HEAD > generated/revision
  dev:seed:
    cmds:
      - bun scripts/dev/seed/stack-probe.ts {{.CLI_ARGS}}
  dev:prepare:
    cmds:
      - touch .temp/storage-prepared
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

  test('a coalesced waiting refresh runs repaired inspection in a fresh staged process', async () => {
    const { dir, stack, revision } = repository();
    const lock = join(dir, '.temp/goal-orchestration/shared-lifecycle');
    let queued: Promise<unknown> | undefined;
    try {
      activateBackend(stack, stageBackend(dir, stack, revision));
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'pid'), String(process.pid));
      queued = refreshSharedStack(dir, ['--wait']).catch(error => error);
      const duplicate = refreshSharedStack(dir, ['--wait']);
      await expect(duplicate).resolves.toBeUndefined();
      writeFileSync(join(dir, 'scripts/dev/inspection.ts'), `export const inspection = 'repaired';`);
      backendCommand(dir, 'git', ['add', 'scripts/dev/inspection.ts']);
      backendCommand(dir, 'git', ['commit', '-m', 'Repair inspection while refresh waits']);
      const merged = backendCommand(dir, 'git', ['rev-parse', 'HEAD']);
      const candidate = join(stack, 'backend-revisions', merged);
      expect(existsSync(candidate)).toBe(false);
      rmSync(lock, { recursive: true });
      // Missing dev.env intentionally stops this stub stack at inspection,
      // before it can issue any Aspire, Docker or owner-storage commands.
      const result = await queued;
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain('Refresh failed in staged checkout');
      const inspection = JSON.parse(readFileSync(join(candidate, '.temp/inspection-result'), 'utf8'));
      expect(inspection.inspection).toBe('repaired');
      expect(inspection.pid).not.toBe(process.pid);
      expect(inspection.cwd).toBe(candidate);
      expect(readFileSync(join(candidate, '.temp/backend-ready'), 'utf8')).toBe(merged);
      expect(activeBackend(stack)).toBe(join(stack, 'backend-revisions', revision));
    } finally {
      rmSync(lock, { recursive: true, force: true });
      await queued;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('refresh starts while a browser run holds the heavy lock', async () => {
    const { dir, stack, revision } = repository();
    const heavy = join(dir, '.temp/goal-orchestration/qa-slots/heavy');
    let release: (() => void) | undefined;
    try {
      activateBackend(stack, stageBackend(dir, stack, revision));
      release = await acquireHeavy(['task', 'web:e2e'], { lockDir: heavy });
      await expect(refreshSharedStack(dir, ['--wait'])).rejects.toThrow('Refresh failed in staged checkout');
      const inspected = JSON.parse(readFileSync(join(stack, 'backend-revisions', revision, '.temp/inspection-result'), 'utf8'));
      expect(inspected.inspection).toBe('original');
      expect(readFileSync(join(heavy, 'pid'), 'utf8')).toBe(String(process.pid));
      expect(existsSync(join(dir, '.temp/goal-orchestration/shared-lifecycle'))).toBe(false);
      const admissions = readFileSync(join(stack, 'backend-revisions', revision, '.temp/build-admission'), 'utf8');
      expect(admissions).toContain('--gib 4 -- task install');
      expect(admissions).toContain('--gib 4 -- task gen');
    } finally {
      release?.();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a recovery command can invoke refresh and retains its lifecycle lease afterward', async () => {
    const { dir, stack, revision } = repository();
    const lock = join(dir, '.temp/goal-orchestration/shared-lifecycle');
    const probe = join(dir, '.temp/recovery-refresh.ts');
    try {
      activateBackend(stack, stageBackend(dir, stack, revision));
      writeFileSync(probe, `
import { readFileSync } from 'node:fs';
import { refreshSharedStack } from '${join(root, 'scripts/dev/refresh-stack.ts')}';
try { await refreshSharedStack(${JSON.stringify(dir)}, ['--wait']); }
catch (error) { if (!String(error).includes('Refresh failed in staged checkout')) throw error; }
if (readFileSync(${JSON.stringify(join(lock, 'pid'))}, 'utf8') !== String(process.pid)) throw new Error('Recovery lost its lease after nested refresh');
`);
      const status = await withRecovery(['bun', probe], { lifecycleLockDirectory: lock });
      expect(status).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(join(stack, 'backend-revisions', revision, '.temp/inspection-result'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('Zone approval from the staged worktree targets shared storage and completes its checkpoint', async () => {
    const { dir, stack, revision } = repository();
    const events: string[] = [];
    try {
      const candidate = stageBackend(dir, stack, revision);
      expect(backendCommand(candidate, 'git', ['rev-parse', '--git-dir']))
        .not.toBe(backendCommand(candidate, 'git', ['rev-parse', '--git-common-dir']));
      writeFileSync(join(stack, 'dev.env'), 'shared-stack-environment');
      const zone = { slug: 'franchise-wiki', digest: 'new', approvedDigest: 'old' };
      const operations = actions(events);
      operations.beforeMutation = async () => { events.push('beforeMutation'); };
      operations.approveZones = async (beforeMutation) => {
        await beforeMutation();
        seedRefreshZones(candidate, stack, [zone.slug]);
      };
      await executeRefresh(refreshPlan({ ...current, zoneApprovals: [zone] }), operations);
      expect(JSON.parse(readFileSync(join(candidate, '.temp/seed-result'), 'utf8'))).toEqual({
        stack, environment: 'shared-stack-environment',
        args: ['--themes-only', '--packages=franchise-wiki'],
      });
      expect(events).toEqual(['waitReady', 'beforeMutation', 'recordSuccess']);
      expect(readFileSync(join(candidate, '.temp/build-admission'), 'utf8'))
        .toContain('--gib 4 -- task dev:seed -- --themes-only --packages=franchise-wiki');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('storage preparation admits possible implicit image builds after fencing writers', async () => {
    const { dir, stack, revision } = repository();
    const events: string[] = [];
    try {
      const candidate = stageBackend(dir, stack, revision);
      const operations = actions(events);
      operations.beforeMutation = async () => { events.push('beforeMutation'); };
      operations.prepareStorage = async () => {
        expect(events).toEqual(['stopWriters', 'beforeMutation']);
        prepareRefreshStorage(candidate);
        events.push('prepareStorage');
      };
      await executeRefresh(refreshPlan({ ...current, storageChanged: true }), operations);
      expect(existsSync(join(candidate, '.temp/storage-prepared'))).toBe(true);
      expect(readFileSync(join(candidate, '.temp/build-admission'), 'utf8'))
        .toContain('--gib 4 -- task dev:prepare');
      expect(events.at(-1)).toBe('recordSuccess');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('already-staged recovery startup waits for image-build memory while browser QA holds the heavy lock', async () => {
    const { dir, stack } = repository();
    const heavy = join(dir, '.temp/goal-orchestration/qa-slots/heavy');
    let releaseBrowser: (() => void) | undefined;
    try {
      ensureBackend(dir, stack);
      const candidate = activeBackend(stack)!;
      const stagedAdmission = readFileSync(join(candidate, '.temp/build-admission'), 'utf8');
      releaseBrowser = await acquireHeavy(['browser'], { lockDir: heavy });
      const env = { REZICS_STACK_PROFILE: 'dev', GOAL_TASK_ID: 'recovery-startup-probe' };
      let now = 0, builds = 0;
      const result = await startDevCompose(dir, env, 'dev', timeout => {
        // Compose discovers a missing pinned image and builds it only now.
        expect(now).toBe(10);
        expect(timeout).toBe(180_000);
        expect(existsSync(heavy)).toBe(true);
        expect(env.REZICS_STACK_PROFILE).toBe('dev');
        builds++;
        return 'image rebuilt; storage ready';
      }, { now: () => now, deadline: 100, pollMs: 10, announce: () => {},
        sleep: async ms => { expect(builds).toBe(0); now += ms; },
        read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: (now === 0 ? 11 : 12) * GiB }) });
      expect(result).toBe('image rebuilt; storage ready');
      expect(builds).toBe(1);
      expect(readFileSync(join(candidate, '.temp/build-admission'), 'utf8')).toBe(stagedAdmission);
      expect(readFileSync(join(heavy, 'pid'), 'utf8')).toBe(String(process.pid));
    } finally {
      releaseBrowser?.();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('shared recovery startup leaves Compose unstarted when host memory never admits its image build', async () => {
    let now = 0, starts = 0;
    await expect(startDevCompose(root, { REZICS_STACK_PROFILE: 'dev', GOAL_TASK_ID: 'recovery-startup-probe' },
      'dev', () => { starts++; }, { now: () => now, deadline: 20, pollMs: 10,
        announce: () => {}, sleep: async ms => { now += ms; },
        read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 11 * GiB }) }))
      .rejects.toThrow('Memory admission deadline');
    expect(starts).toBe(0);
    expect(now).toBe(20);
  });

  test('recovery startup admits installation and generation when its pinned revision needs staging', () => {
    const { dir, stack, revision } = repository();
    try {
      ensureBackend(dir, stack);
      const previous = activeBackend(stack)!;
      expect(previous).toBe(join(stack, 'backend-revisions', revision));
      const firstAdmission = readFileSync(join(previous, '.temp/build-admission'), 'utf8');
      expect(firstAdmission).toContain('--gib 4 -- task install');
      expect(firstAdmission).toContain('--gib 4 -- task gen');
      writeFileSync(join(dir, 'yarn.lock'), 'recovery-dependencies');
      backendCommand(dir, 'git', ['add', 'yarn.lock']);
      backendCommand(dir, 'git', ['commit', '-m', 'Recovery dependency change']);
      const target = backendCommand(dir, 'git', ['rev-parse', 'HEAD']);
      writeFileSync(join(stack, 'refresh-pending'), JSON.stringify({
        revision: target, backend: previous, storage: previous, pid: 2147483647,
        refreshId: 'incomplete-maintenance', mutatingStep: 'align-model',
      }));
      ensureBackend(dir, stack);
      const candidate = activeBackend(stack)!;
      expect(candidate).toBe(join(stack, 'backend-revisions', target));
      const recoveryAdmission = readFileSync(join(candidate, '.temp/build-admission'), 'utf8');
      expect(recoveryAdmission).toContain('--gib 4 -- task install');
      expect(recoveryAdmission).toContain('--gib 4 -- task gen');
      expect(readPendingRefresh(stack)?.mutatingStep).toBe('align-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

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
      operations.switchBackend = async () => {
        activateBackend(stack, candidate);
      };
      operations.restartResources = async () => {
        backend = await start(dir, stack);
      };
      operations.waitReady = async () => {
        expect(await (await fetch(new URL('/health/ready', backend!.url))).json()).toEqual({
          revision: target,
          generated: target,
        });
        };
      operations.recordSuccess = async () => {
        writeFileSync(join(stack, 'refresh.json'), JSON.stringify({ revision: target }));
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

  test('failed postcommit model alignment retains forward progress and leaves writers stopped', async () => {
    const { dir, stack, revision } = repository();
    let backend: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const previous = stageBackend(dir, stack, revision);
      activateBackend(stack, previous);
      backend = await start(dir, stack);
      let model = revision;
      const operations = actions([]);
      operations.stopWriters = async () => {
        await backend?.stop();
        backend = undefined;
      };
      operations.alignModel = async () => {
        model = 'new-model';
        throw new Error('Audit failed after model head committed');
      };
      operations.restartPrevious = async () => {
        throw new Error('Must not restart incompatible previous code');
      };
      await expect(
        executeRefresh(
          refreshPlan({
            ...current,
            modelCurrent: false}),
          operations),
      ).rejects.toThrow('Refresh failed at align-model: Audit failed after model head committed. Storage/model may have changed; writers remain stopped. Retry: task dev:refresh -- --wait',
      );
      expect(model).toBe('new-model');
      expect(backend).toBeUndefined();
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
      const target = backendCommand(candidate, 'git', ['rev-parse', 'HEAD']);
      writeFileSync(join(stack, 'refresh-pending'),
        JSON.stringify({
          revision: target,
          backend: previous,
          storage: previous,
          pid: 2147483647,
          refreshId: 'failed',
          mutatingStep: 'align-model',
        }),
      );
      ensureBackend(dir, stack);
      expect(activeBackend(stack)).toBe(candidate);
      expect(readPendingRefresh(stack)?.mutatingStep).toBe('align-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  for (const loadedStamp of [true, false]) {
    test(`a topology merge during model maintenance cannot invalidate the frozen refresh (${loadedStamp ? 'loaded stamp' : 'session checkpoint'})`, async () => {
      const { dir, stack, revision } = repository();
      const events: string[] = [];
      const session = 'http://127.0.0.1:17000';
      try {
        const candidate = stageBackend(dir, stack, revision);
        activateBackend(stack, candidate);
        const frozenHash = appHostSourceHash(candidate);
        writeFileSync(join(stack, 'refresh.json'), JSON.stringify({ revision,
          appHostHash: frozenHash, appHostSession: session }));
        if (loadedStamp) writeFileSync(join(stack, 'apphost-hash'), frozenHash);
        const initial = inspectRefreshAppHost(candidate, dir, session);
        expect(initial.appHostChanged).toBe(false);
        const operations = actions(events);
        operations.beforeMutation = async () => { events.push('beforeMutation'); };
        operations.restartResources = async () => {
          events.push('restartResources');
          writeFileSync(join(dir, 'apphost/apphost.mts'), `export const topology = 'later';`);
          backendCommand(dir, 'git', ['add', 'apphost/apphost.mts']);
          backendCommand(dir, 'git', ['commit', '-m', 'Advance topology while refresh runs']);
        };
        operations.recordSuccess = async () => {
          const checked = inspectRefreshAppHost(candidate, dir, session);
          if (!refreshIsCurrent({ ...current, revision, previousRevision: revision,
            appHostChanged: checked.appHostChanged })) throw new Error('Final inspection rejected frozen topology');
          writeFileSync(checked.checkpointPath, JSON.stringify({ revision,
            appHostHash: checked.appHostHash, appHostSession: session }));
          events.push('recordSuccess');
        };
        await executeRefresh(refreshPlan({ ...current, revision, previousRevision: revision,
          modelCurrent: false, appHostChanged: initial.appHostChanged }), operations);
        expect(events).toContain('beforeMutation');
        expect(events.at(-1)).toBe('recordSuccess');
        expect(events.filter(event => event === 'stopWriters')).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(stack, 'refresh.json'), 'utf8'))).toEqual({ revision,
          appHostHash: frozenHash, appHostSession: session });
        expect(backendCommand(activeBackend(stack)!, 'git', ['rev-parse', 'HEAD'])).toBe(revision);
        expect(backendCommand(dir, 'git', ['rev-parse', 'HEAD'])).not.toBe(revision);
        // The next refresh must still demand a restart for that later topology.
        expect(inspectRefreshAppHost(dir, dir, session).appHostChanged).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('a newer maintenance code fix retains the previous generation intent and audit checkpoint', () => {
    const { dir, stack, revision } = repository();
    try {
      const previous = stageBackend(dir, stack, revision);
      activateBackend(stack, previous);
      const intent = join(previous, '.temp/datasets/model-bootstrap/intent.json');
      writeFileSync(intent, '{"generation":"already-committed","audit":"unfinished"}');
      backendCommand(dir, 'git', ['commit', '--allow-empty', '-m', 'Maintenance code fix']);
      const next = stageBackend(dir, stack, backendCommand(dir, 'git', ['rev-parse', 'HEAD']));
      expect(readFileSync(join(next, '.temp/datasets/model-bootstrap/intent.json'), 'utf8')).toBe(readFileSync(intent, 'utf8'));
      writeFileSync(join(next, '.temp/datasets/model-bootstrap/completed.json'), 'audit finished');
      expect(readFileSync(join(previous, '.temp/datasets/model-bootstrap/completed.json'), 'utf8')).toBe('audit finished');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test('an existing private model intent is adopted without copying owner data', () => {
    const dir = mkdtempSync(join(root, '.temp/model-intent-'));
    const checkout = join(dir, 'checkout');
    const stack = join(dir, 'stack');
    mkdirSync(join(checkout, '.temp/datasets/model-bootstrap'), { recursive: true });
    writeFileSync(join(checkout, '.temp/datasets/model-bootstrap/intent.json'), 'unfinished intent');
    try {
      linkBackendModelJournal(checkout, stack);
      expect(readFileSync(join(stack, 'model-bootstrap/intent.json'), 'utf8')).toBe('unfinished intent');
      linkBackendModelJournal(checkout, stack);
      expect(readFileSync(join(checkout, '.temp/datasets/model-bootstrap/intent.json'), 'utf8')).toBe('unfinished intent');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  });

describe('refresh storage planning', () => {
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
      'build-image', 'rehearse-migrations', 'stop-writers', 'prepare-storage', 'align-model',
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
        'stop-writers', 'prepare-storage', 'align-model',
        'switch-backend', 'restart-resources', 'wait-ready', 'approve-zones', 'record-success',
      ]);
    });
  }

  test('candidate membership inspection defers old-module operations until stopped-writer preparation', async () => {
    let calls = 0;
    const oldModule = { membershipPreparationStatus: async () => {
      calls++; throw new Error('Membership preparation status returned 400');
    } };
    const membershipCurrent = await refreshMembershipCurrent(true, true, oldModule);
    expect(calls).toBe(0);
    expect(membershipCurrent).toBe(false);
    const events: string[] = [];
    await executeRefresh(refreshPlan({ ...current, storageChanged: true, membershipCurrent }), actions(events));
    expect(events.indexOf('stopWriters')).toBeLessThan(events.indexOf('prepareStorage'));
    expect(events.indexOf('prepareStorage')).toBeLessThan(events.indexOf('restartResources'));
    expect(await refreshMembershipCurrent(false, true, {
      membershipPreparationStatus: async () => ({ needsPreparation: false }),
    })).toBe(true);
    await expect(refreshMembershipCurrent(false, true, oldModule)).rejects.toThrow('returned 400');
    expect(calls).toBe(1);
    expect(await refreshMembershipCurrent(false, false, oldModule)).toBe(false);
    expect(calls).toBe(1);
    expect(await refreshMembershipCurrent(false, true, {
      membershipPreparationStatus: async () => ({ needsPreparation: true }),
    })).toBe(false);
  });

  test('legacy ordered membership requires stopped-writer owner preparation even at the recorded revision', async () => {
    const plan = refreshPlan({ ...current, membershipCurrent: false });
    expect(plan.steps).toEqual(['stop-writers',
      'prepare-storage', 'align-model',
      'switch-backend',
      'restart-resources', 'wait-ready', 'approve-zones', 'record-success']);
    const events: string[] = [];
    await expect(executeRefresh(plan, actions(events, 'prepareStorage'))).rejects.toThrow('failed prepareStorage');
    expect(events).toEqual(['stopWriters', 'prepareStorage',
      'stopWriters']);
    await executeRefresh(plan, actions([]));
    expect(refreshPlan(current).steps).toEqual([]);
  });

  test('a stale model generation is aligned without unnecessary storage work', () => {
    expect(refreshPlan({ ...current, modelCurrent: false }).steps).toEqual([
      'stop-writers',
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

  test('main mode declares fixed non-ephemeral listen ports for Main, Account and the relay', () => {
    const source = readFileSync(join(root, 'apphost/apphost.mts'), 'utf8');
    const declared = source.match(
      /export const mainModeListenPorts = \{ account: (\d+), main: (\d+), 'main-relay': (null|\d+) \} as const;/,
    );
    expect(declared).not.toBeNull();
    const account = Number(declared![1]);
    const main = Number(declared![2]);
    const relay = declared![3] === 'null' ? null : Number(declared![3]);
    for (const port of [account, main, relay]) {
      if (port === null) continue;
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(32_768);
    }
    expect(account).not.toBe(3002);
    expect(main).not.toBe(3001);
    expect(new Set([account, main, relay]).size).toBe(3);
    // The proxy stays on the public ports. The relay declares no socket.
    expect(relay).toBeNull();
    expect(source).toContain('const targetPort = mainModeListenPorts[');
    expect(source).toContain('return { port, targetPort, env: variable, isProxied: true as const }');
    expect(source).toContain("withHttpEndpoint(serviceEndpoint(3002, 'ACCOUNT_PORT'))");
    expect(source).toContain("withHttpEndpoint(serviceEndpoint(3001, 'MAIN_PORT'))");
    expect(source).toContain(".withHttpHealthCheck({ path: '/health/ready' })");
    const relaySource = source.slice(source.indexOf("addExecutable('main-relay'"));
    expect(relaySource.slice(0, relaySource.indexOf('accountUrl ='))).not.toContain('withHttpEndpoint');
  });

  test('writers that have never started plan without an environment blocker', () => {
    const expected = { ACCOUNT_BASE_URL: 'http://127.0.0.1:3004' };
    const changes = refreshLoadedEnvironmentChanges({
      account: { state: 'NotStarted' },
      main: { state: 'NotStarted' },
      'main-relay': { state: 'NotStarted' },
    }, expected);
    expect(changes).toEqual([]);
    const plan = refreshPlan({ ...current, environmentChanges: changes,
      unhealthyResources: ['account', 'main', 'main-relay'] });
    expect(plan.blockers).toEqual([]);
    expect(plan.steps).toContain('restart-resources');
    expect(plan.steps).toContain('wait-ready');
  });

  test('a running writer with a stale loaded value still blocks refresh', () => {
    const expected = { ACCOUNT_BASE_URL: 'http://127.0.0.1:3004', ACCOUNT_SECRET: 'loaded-secret' };
    const running = {
      account: { state: 'Running', environment: {
        ACCOUNT_BASE_URL: 'http://127.0.0.1:9', ACCOUNT_PORT: '3012', OTEL_SERVICE_NAME: 'stale',
        ACCOUNT_SECRET: null,
      } },
      main: { state: 'Running', environment: {} },
      'main-relay': { state: 'Running', environment: {} },
    };
    const changes = refreshLoadedEnvironmentChanges(running, expected);
    expect(changes).toEqual(['account.ACCOUNT_BASE_URL']);
    const plan = refreshPlan({ ...current, environmentChanges: changes });
    expect(plan.blockers.join('\n')).toContain('Generated stack environment would change');
    expect(plan.blockers.join('\n')).toContain('account.ACCOUNT_BASE_URL');
    expect(refreshLoadedEnvironmentChanges({
      account: { state: 'Running', environment: {
        ACCOUNT_BASE_URL: expected.ACCOUNT_BASE_URL, ACCOUNT_SECRET: null,
      } },
      main: { state: 'Running', environment: {} },
      'main-relay': { state: 'Running', environment: {} },
    }, expected)).toEqual([]);
    // A writer that already started and then stopped still has an environment to compare.
    expect(refreshLoadedEnvironmentChanges({
      account: { state: 'Exited' }, main: { state: 'Finished' }, 'main-relay': { state: 'Stopped' },
    }, { ACCOUNT_BASE_URL: expected.ACCOUNT_BASE_URL })).toEqual(['account.ACCOUNT_BASE_URL']);
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
    stopWriters: step('stopWriters'), beforeMutation: async ()=> {},
    switchBackend: step('switchBackend'),
    restartPrevious: step('restartPrevious'),
    prepareStorage: step('prepareStorage'),
    alignModel: step('alignModel'), restartResources: step('restartResources'), waitReady: step('waitReady'),
    approveZones: step('approveZones'), stopAppHost: step('stopAppHost'), recordSuccess: step('recordSuccess') };
}

describe('shared stack refresh execution and guards', () => {
  test('readiness re-describes restarted resources when stopped Account had no preflight URL', async () => {
    const before = {
      account: { name: 'account', state: 'Finished' },
      main: { name: 'main', state: 'Finished' },
      'main-relay': { name: 'main-relay', state: 'Finished' },
    };
    let resources: ReturnType<Parameters<typeof waitRefreshReady>[0]> =
      before;
    const requested: string[] = [];
    const operations = actions([]);
    operations.restartResources = async () => {
      resources = {
        account: {
          name: 'account',
          state: 'Running',
          properties: { 'executable.pid': 11 },
          urls: [{ url: 'http://127.0.0.1:41001' }],
        },
        main: {
          name: 'main',
          state: 'Running',
          properties: { 'executable.pid': 12 },
          urls: [{ url: 'http://127.0.0.1:41002' }],
        },
        'main-relay': {
          name: 'main-relay',
          state: 'Running',
          properties: { 'executable.pid': 13 },
        },
      };
    };
    operations.waitReady = () =>
      waitRefreshReady(
        () => resources,
        (async (input) => {
          requested.push(String(input));
          return new Response(null, { status: 200 });
        }) as typeof fetch,
        () => true,
      );
    await executeRefresh(
      refreshPlan({ ...current, unhealthyResources: ['account', 'main', 'main-relay'] }),
      operations,
    );
    expect(before.account).not.toHaveProperty('urls');
    expect(requested).toEqual([
      'http://127.0.0.1:41001/health/ready',
      'http://127.0.0.1:41002/health/ready',
    ]);
  });

  for (const failure of [
    'stopWriters',
    'switchBackend',
    'restartResources',
    'waitReady',
  ] as const) {
    test(`${failure} failure before maintenance restarts the previous revision`, async () => {
      const events: string[] = [];
      await expect(
        executeRefresh(refreshPlan({ ...current, revision: 'new-code' }), actions(events, failure)),
      ).rejects.toThrow('Previous revision retained. Retry: task dev:refresh -- --wait');
      expect(events.at(-1)).toBe('restartPrevious');
    });
  }

  test('resume replays alignment even when the model head already advanced before an audit failure', () => {
    const plan = refreshPlan({ ...current, resumeStep: 'align-model' });
    expect(plan.steps).toContain('align-model');
    expect(plan.steps).not.toContain('prepare-storage');
  });

  test('a resumed maintenance failure during image build cannot restart the old revision', async () => {
    const events: string[] = [];
    await expect(
      executeRefresh(
        refreshPlan({ ...current, imagePresent: false }),
        actions(events, 'buildImage'),
        true,
      ),
    ).rejects.toThrow('writers remain stopped. Retry: task dev:refresh -- --wait');
    expect(events).toEqual(['buildImage', 'stopWriters']);
  });
  test('an incomplete Statement upgrade prepares stopped storage and cannot restart on conversion failure', async () => {
    const events: string[] = [];
    await expect(executeRefresh(refreshPlan({...current,statementCurrent: false}),actions(events,'prepareStorage')))
      .rejects.toThrow('failed prepareStorage');
    expect(events).toEqual(['stopWriters','prepareStorage',
      'stopWriters']);
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
    expect(events).toEqual(['buildImage', 'stopWriters', 'prepareStorage', 'alignModel',
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
    expect(retry).toEqual(['rehearseMigrations', 'stopWriters',
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

  test('lifecycle lock inspection detects live owners and the creation race without modifying stale locks', () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const dir = mkdtempSync(join(root, '.temp/refresh-lock-'));
    const lock = join(dir, 'shared-lifecycle');
    try {
      expect(refreshLifecycleLockHeld(lock)).toBe(false);
      mkdirSync(lock);
      expect(refreshLifecycleLockHeld(lock, () => false)).toBe(true);
      writeFileSync(join(lock, 'pid'), '99999999');
      const old = new Date(Date.now() - 20_000);
      utimesSync(lock, old, old);
      expect(refreshLifecycleLockHeld(lock, () => true)).toBe(true);
      expect(refreshLifecycleLockHeld(lock, () => false)).toBe(false);
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

  for (const fails of [false, true]) {
    test(`marked online indexes rehearse transactionally and ${fails ? 'reject a wrong column before stopping writers' : 'preserve predicates and comments'}`, async () => {
      const { dir, first } = fixture();
      const sql = `-- migrate: concurrent-index access.online_probe
-- CONCURRENTLY in comments stays intact.
CREATE UNIQUE INDEX /* build */ CONCURRENTLY online_probe ON access.event (${fails ? 'missing_column' : 'epoch'})
WHERE note <> 'CONCURRENTLY;';`;
      writeFileSync(join(dir, first), sql);
      const events: string[] = [];
      const operations = actions(events);
      operations.rehearseMigrations = () => rehearseRefreshMigrations(dir, env, [first], () => ({
        connect: async () => {},
        query: async query => {
          events.push(query.startsWith('DO $$') ? 'isolate-sequences' : query);
          if (query.includes('missing_column')) throw new Error('column missing_column does not exist');
        },
        end: async () => { events.push('end'); },
      }));
      try {
        const run = executeRefresh(refreshPlan({ ...current, pendingMigrations: [first] }), operations);
        if (fails) {
          await expect(run).rejects.toThrow(`Migration rehearsal failed: ${first}: column missing_column does not exist`);
          expect(events).not.toContain('stopWriters');
        } else await run;
        expect(events.slice(0, 6)).toEqual(['BEGIN', 'isolate-sequences', 'DROP INDEX IF EXISTS access.online_probe',
          sql.replace('/* build */ CONCURRENTLY', '/* build */ '), 'ROLLBACK', 'end']);
        expect(readFileSync(join(dir, first), 'utf8')).toBe(sql);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test.each(['SELECT 1;', 'CREATE INDEX CONCURRENTLY probe ON source(id); SELECT 1;',
    'CREATE INDEX probe ON source(id);'])('marker files must contain exactly one online index: %s', sql => {
    expect(() => sqlMigration(`-- migrate: concurrent-index access.probe\n${sql}`, 'probe.sql'))
      .toThrow('exactly one CREATE INDEX CONCURRENTLY');
  });

  test.each(['CREATE INDEX CONCURRENTLY other ON access.event(epoch);',
    'CREATE INDEX CONCURRENTLY probe ON content.event(epoch);'])('the recovery marker must name the index being created: %s', sql => {
    expect(() => sqlMigration(`-- migrate: concurrent-index access.probe\n${sql}`, 'probe.sql'))
      .toThrow('marker does not match its CREATE INDEX target');
  });

  test('quoted targets retain their identity and duplicate markers are rejected', () => {
    const sql = '-- migrate: concurrent-index access.probe\nCREATE INDEX CONCURRENTLY "probe" ON "access"."event"(epoch);';
    expect(sqlMigration(sql, 'probe.sql').concurrentIndex).toBe('access.probe');
    expect(() => sqlMigration(`-- migrate: concurrent-index content.other\n${sql}`, 'probe.sql'))
      .toThrow('exactly one marker');
  });

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

describe('refresh image build', () => {
  function stack(script: string) {
    const dir = mkdtempSync(join(root, '.temp/image-build-'));
    const state = join(dir, '.temp/stack/rezics-dev');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'compose.env'), 'SECRET_VALUE=do-not-log\n');
    const docker = join(dir, 'docker');
    writeFileSync(docker, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { dir, docker, log: join(state, 'image-build.log') };
  }

  test('budget covers the measured native build', () => {
    expect(imageBuildBudgetMs).toBe(45 * 60_000);
  });

  test('a build that outlives the budget reports a timeout', async () => {
    const { dir, docker, log } = stack('echo started; exec sleep 30');
    try {
      const started = Date.now();
      await expect(buildRefreshImage(dir, dir, { budgetMs: 300, executable: docker }))
        .rejects.toThrow('image build exceeded 0.3 s');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(readFileSync(log, 'utf8')).toContain('started');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a failing build names its private log, which holds the output', async () => {
    const { dir, docker, log } = stack('echo "step 3/9 mvn package"; echo "BUILD FAILURE" >&2; exit 255');
    try {
      const error = await buildRefreshImage(dir, dir, { executable: docker }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) return;
      expect(error.message).toContain('exit 255');
      expect(error.message).toContain(log);
      expect(readFileSync(log, 'utf8')).toContain('step 3/9 mvn package');
      expect(readFileSync(log, 'utf8')).toContain('BUILD FAILURE');
      expect(statSync(log).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('output beyond the 8 MiB buffer does not fail the step', async () => {
    const { dir, docker, log } = stack('head -c 20971520 /dev/zero | tr "\\0" x; echo; echo done >&2');
    try {
      await buildRefreshImage(dir, dir, { executable: docker });
      expect(statSync(log).size).toBeGreaterThan(20 * 1024 * 1024);
      expect(readFileSync(log, 'utf8').endsWith('done\n')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('refresh build step output', () => {
  test('a failing build step keeps its output in an owner-only log in the stack directory', () => {
    const stack = mkdtempSync(join(root, '.temp/refresh-build-log-'));
    try {
      const candidate = join(stack, 'backend-revisions', 'abc123');
      mkdirSync(candidate, { recursive: true });
      const path = refreshBuildStepLog(candidate, ['dev:seed', '--', '--themes-only'],
        'seed failed: Main HTTP 503\n', new Date('2026-10-08T13:00:00.000Z'));
      expect(dirname(path)).toBe(stack);
      expect(path).toContain('refresh-build-dev:seed-20261008T130000000Z.log');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('seed failed: Main HTTP 503\n');
    } finally { rmSync(stack, { recursive: true, force: true }); }
  });
});

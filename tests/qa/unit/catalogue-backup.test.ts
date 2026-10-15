import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusBackupSourceDirectory, restoreCatalogueBackup, retainStoppedOwnerBackup } from '../../../scripts/load/catalogue-backup.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import { fixtureRoot, root, VOLUME_KINDS } from '../../../scripts/fixture/stack.ts';

test('shared retained backups are readable from a worktree while backup publication stays local', async () => {
  const checkout = join(root, '.temp/source-boundary/worktree');
  const fixtures = join(root, '.temp/source-boundary/shared/fixture');
  const shared = join(root, '.temp/source-boundary/shared/work-profiles/seed-checkpoints/small');
  expect(corpusBackupSourceDirectory(shared, checkout, fixtures)).toBe(shared);
  expect(corpusBackupSourceDirectory(join(checkout, '.temp/backup'), checkout, fixtures)).toBe(join(checkout, '.temp/backup'));
  expect(() => corpusBackupSourceDirectory(join(shared, '../../../outside'), checkout, fixtures)).toThrow('backup source');
  const actualShared = join(fixtureRoot, '../work-profiles/seed-checkpoints/never-publish');
  if (!actualShared.startsWith(`${root}/`))
    await expect(retainStoppedOwnerBackup('read-only-proof', 'cut', actualShared, Date.now()))
      .rejects.toThrow('this checkout .temp');
});

async function restoreScenario(mode: 'copy-failure' | 'volume-create-failure' | 'budget' | 'success' | 'ordinary-allocation' | 'timing' | 'admission-wait' | 'existing-volume' | 'existing-directory' | 'startup-failure' | 'startup-diagnostics' | 'cleanup-failure') {
  const directory = mkdtempSync(join(root, '.temp/catalogue-restore-'));
  const runId = directory.split('/').at(-1)!.toLowerCase();
  const project = `rezics-qa-${runId}`;
  const target = join(root, '.temp/stack', project);
  const volumes = new Set<string>();
  let running = false;
  let elapsed = 0;
  const commands: string[][] = [];
  const retargeted: Record<string, string>[] = [];
  const failure = new Error('injected volume copy failure');
  try {
    writeFileSync(join(directory, 'backup.json'), JSON.stringify({
      format: 'command-catalogue-backup-v1', project: 'rezics-catalogue-g1038-source',
      runId: 'source', compatibility: loadCompatibility(root),
    }));
    writeFileSync(join(directory, 'compose.env'), 'ACCOUNT_PORT=3002\nFUSEKI_PORT=3030\n');
    mkdirSync(join(directory, 'objects'));
    writeFileSync(join(directory, 'objects/retained'), 'immutable object');
    if (mode === 'existing-volume') volumes.add(`${project}_${VOLUME_KINDS[1]}`);
    if (mode === 'existing-directory') {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'retained'), 'existing target');
    }
    const operation = restoreCatalogueBackup(join(directory, 'backup.json'), runId, {
      resourceClass: mode === 'ordinary-allocation' ? 'ordinary' : undefined,
      now: () => elapsed,
      dockerEnvironment: () => ({}), projectRunning: () => false,
      freshPorts: async () => { if (mode === 'timing') elapsed += 10; return {}; },
      repairCollations: async () => [],
      retargetGraphRoute: async apps => { retargeted.push(apps); if (mode === 'timing') elapsed += 50; },
      run: (_program, args) => {
        commands.push(args);
        if (args[0] === 'logs' && mode === 'startup-diagnostics') return 'FATAL: data directory has wrong ownership';
        if (args[0] === 'volume' && args[1] === 'ls') {
          const name = args.at(-1)!.slice('name=^'.length, -1);
          return volumes.has(name) ? name : '';
        }
        if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args[2]!);
        if (args[0] === 'volume' && args[1] === 'create') {
          volumes.add(args.at(-1)!);
          if (mode === 'volume-create-failure') throw failure;
        }
        return '';
      },
      copyVolume: async (_source, destination) => {
        const kind = destination.slice(project.length + 1);
        expect(volumes.has(destination)).toBe(true);
        expect(commands.at(-1)).toEqual(['volume', 'create',
          '--label', `com.docker.compose.project=${project}`,
          '--label', `com.docker.compose.volume=${kind}`, destination]);
        if (mode === 'timing') elapsed += 20;
        volumes.add(destination);
        if (mode === 'copy-failure') throw failure;
      },
      task: async args => {
        commands.push(args);
        if (args[0] === 'stack:up') {
          if (mode === 'timing') elapsed += 100;
          running = true;
          if (mode === 'startup-failure') throw new Error('injected startup failure');
          if (mode === 'startup-diagnostics') throw new Error('injected startup failure');
          if (mode === 'cleanup-failure') throw failure;
          if (mode === 'budget') elapsed = 600_001;
          if (mode === 'admission-wait') {
            elapsed = 1_000_000;
            return 'QA_MEMORY_WAIT_BEGIN 123-1\nQA_MEMORY_WAIT_END 123-1 700000\n';
          }
        }
        if (args[0] === 'stack:reset') {
          running = false;
          if (mode === 'cleanup-failure') throw new Error('injected reset failure');
          volumes.clear();
        }
        return '';
      },
    });
    if (mode === 'success' || mode === 'ordinary-allocation' || mode === 'timing' || mode === 'admission-wait') {
      const restored = await operation;
      if (mode === 'admission-wait') {
        expect(restored.elapsedMs).toBe(300_000);
        expect(restored.admissionWaitMs).toBe(700_000);
        expect(restored.preparation).toEqual({ restoreMs: 0, startupMs: 1_000_000,
          volumeCopyMs: { postgres_data: 0, fuseki_data: 0, rustfs_data: 0 }, objectCopyMs: 0,
          readinessMs: 0, totalMs: 1_000_000 });
      }
      if (mode === 'timing') expect(restored.preparation).toEqual({
        restoreMs: 10 + 20 * VOLUME_KINDS.length, startupMs: 100, readinessMs: 50,
        volumeCopyMs: { postgres_data: 20, fuseki_data: 20, rustfs_data: 20 }, objectCopyMs: 0,
        totalMs: 160 + 20 * VOLUME_KINDS.length,
      });
      expect(running).toBe(true);
      expect(volumes.size).toBe(VOLUME_KINDS.length);
      expect(retargeted).toHaveLength(1);
      expect(retargeted[0]?.FUSEKI_URL).toBe('http://127.0.0.1:3030/rezics/');
      expect(readFileSync(join(target, 'objects/retained'), 'utf8')).toBe('immutable object');
      if (mode === 'ordinary-allocation') {
        const compose = readFileSync(join(target, 'compose.env'), 'utf8');
        expect(compose).toContain('REZICS_FUSEKI_MEMORY_LIMIT=2g');
        expect(compose).toContain('-Xmx512m');
      }
      await restored.stop();
    } else {
      await expect(operation.catch(error => {
        if (mode === 'copy-failure' || mode === 'volume-create-failure') expect(error).toBe(failure);
        if (mode === 'cleanup-failure') {
          expect(error).toBeInstanceOf(AggregateError);
          expect(error.cause).toBe(failure);
          expect(error.errors).toHaveLength(2);
        }
        throw error;
      })).rejects.toThrow(mode === 'budget' ? 'exceeded 600 seconds'
        : mode === 'existing-volume' ? 'already has storage'
        : mode === 'existing-directory' ? 'already exists'
        : mode === 'startup-diagnostics' ? 'data directory has wrong ownership'
        : mode === 'startup-failure' ? 'injected startup failure' : failure.message);
      if (mode === 'startup-diagnostics') {
        expect(commands.findIndex(args => args[0] === 'logs'))
          .toBeLessThan(commands.findIndex(args => args[0] === 'stack:reset'));
      }
    }
    if (mode === 'existing-volume') {
      expect([...volumes]).toEqual([`${project}_${VOLUME_KINDS[1]}`]);
      expect(commands.some(args => args[0] === 'stack:reset' || args[1] === 'rm')).toBe(false);
    } else expect(volumes.size).toBe(0);
    if (mode === 'existing-directory') {
      expect(readFileSync(join(target, 'retained'), 'utf8')).toBe('existing target');
      expect(commands.some(args => args[0] === 'stack:reset' || args[1] === 'rm')).toBe(false);
    } else expect(existsSync(target)).toBe(false);
    expect(running).toBe(false);
    expect(existsSync(join(directory, 'objects/retained'))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

test('catalogue restore: a volume copy failure removes its partially copied volumes and target', async () => {
  await restoreScenario('copy-failure');
});
test('catalogue restore: a volume creation failure removes its partially created storage', async () => {
  await restoreScenario('volume-create-failure');
});
test('catalogue backup: disposable source stores are rejected before creating a backup', async () => {
  const directory = mkdtempSync(join(root, '.temp/catalogue-source-'));
  const runId = directory.split('/').at(-1)!.toLowerCase();
  const source = join(root, '.temp/stack', `rezics-qa-${runId}`);
  const backup = join(directory, 'backup');
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'compose.env'), 'REZICS_STACK_STORAGE=tmpfs\n');
    await expect(retainStoppedOwnerBackup(runId, 'cut', backup, Date.now()))
      .rejects.toThrow('require a persistent catalogue-disk QA source');
    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(join(source, 'compose.env'), 'utf8')).toBe('REZICS_STACK_STORAGE=tmpfs\n');
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
test('catalogue backup: new capture resumes PostgreSQL and cached reuse never stops it', async () => {
  const directory = mkdtempSync(join(root, '.temp/catalogue-capture-'));
  const runId = directory.split('/').at(-1)!.toLowerCase();
  const source = join(root, '.temp/stack', `rezics-qa-${runId}`);
  const backup = join(directory, 'backup');
  const objects = join(directory, 'objects');
  let running = true;
  const events: string[] = [];
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(objects);
    writeFileSync(join(objects, 'retained'), 'immutable object');
    writeFileSync(join(source, 'compose.env'), 'REZICS_STACK_STORAGE=persistent\n');
    writeFileSync(join(source, 'apps.env'), `MAIN_OBJECT_DIRECTORY=${objects}\n`);
    const options = {
      stopSourcePostgres: async () => { events.push('postgres-stop'); running = false; },
    };
    const dependencies = {
      dockerEnvironment: () => ({}),
      projectRunning: () => running,
      task: async (args: string[]) => {
        events.push(args[0]!);
        running = args[0] === 'stack:up';
        return '';
      },
      copyVolume: async () => { expect(running).toBe(false); events.push('copy'); },
    };
    for (let call = 0; call < 2; call += 1) {
      expect(await retainStoppedOwnerBackup(runId, 'cut', backup, Date.now(), options, dependencies))
        .toBe(join(backup, 'backup.json'));
      expect(running).toBe(true);
    }
    expect(events).toEqual(['postgres-stop', 'stack:down', ...VOLUME_KINDS.map(() => 'copy'), 'stack:up']);
    expect(readFileSync(join(backup, 'objects/retained'), 'utf8')).toBe('immutable object');
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
test('catalogue backup: failed shutdown certification resumes source even when capture requested it stopped', async () => {
  const directory = mkdtempSync(join(root, '.temp/catalogue-failure-'));
  const runId = directory.split('/').at(-1)!.toLowerCase();
  const source = join(root, '.temp/stack', `rezics-qa-${runId}`);
  const backup = join(directory, 'backup');
  const objects = join(directory, 'objects');
  const failure = new Error('shutdown control file could not be certified');
  const events: string[] = [];
  let running = true;
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(objects);
    writeFileSync(join(objects, 'retained'), 'immutable object');
    writeFileSync(join(source, 'compose.env'), 'REZICS_STACK_STORAGE=persistent\n');
    writeFileSync(join(source, 'apps.env'), `MAIN_OBJECT_DIRECTORY=${objects}\n`);
    await expect(retainStoppedOwnerBackup(runId, 'cut', backup, Date.now(), {
      resumeSource: false,
      stopSourcePostgres: async () => {
        events.push('postgres-stop');
        running = false;
        throw failure;
      },
    }, {
      dockerEnvironment: () => ({}),
      run: (_program, args) => {
        expect(args.slice(0, 3)).toEqual(['volume', 'ls', '-q']);
        return '';
      },
      task: async args => {
        events.push(args[0]!);
        running = args[0] === 'stack:up';
        return '';
      },
      copyVolume: async () => { events.push('copy'); },
    })).rejects.toBe(failure);
    expect(events).toEqual(['postgres-stop', 'stack:up']);
    expect(running).toBe(true);
    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(join(objects, 'retained'), 'utf8')).toBe('immutable object');
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
test('catalogue restore: exceeding the budget after startup removes the stack, volumes and target', async () => {
  await restoreScenario('budget');
});
test('catalogue restore: memory admission does not consume the preparation budget', async () => {
  await restoreScenario('admission-wait');
});
test('catalogue restore: preparation records copy, startup and readiness wall time separately', async () => {
  await restoreScenario('timing');
});
test('catalogue restore: modest copies use the existing ordinary memory allocation', async () => {
  await restoreScenario('ordinary-allocation');
});
test('catalogue restore: failed startup retains PostgreSQL diagnostics before cleanup', async () => {
  await restoreScenario('startup-diagnostics');
});
test('catalogue restore: preexisting storage and directories survive rejection', async () => {
  await restoreScenario('existing-volume');
  await restoreScenario('existing-directory');
});
test('catalogue restore: partial startup is reset and successful callers retain a stop handle', async () => {
  await restoreScenario('startup-failure');
  await restoreScenario('success');
});

test('catalogue restore: reset failure preserves the original error and attempts remaining cleanup', async () => {
  await restoreScenario('cleanup-failure');
});

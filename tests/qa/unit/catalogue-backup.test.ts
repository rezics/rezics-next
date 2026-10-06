import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreCatalogueBackup } from '../../../scripts/load/catalogue-backup.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import { root, VOLUME_KINDS } from '../../../scripts/fixture/stack.ts';

async function restoreScenario(mode: 'copy-failure' | 'budget' | 'success' | 'existing-volume' | 'existing-directory' | 'startup-failure' | 'cleanup-failure') {
  const directory = mkdtempSync(join(root, '.temp/catalogue-restore-'));
  const runId = directory.split('/').at(-1)!.toLowerCase();
  const project = `rezics-qa-${runId}`;
  const target = join(root, '.temp/stack', project);
  const volumes = new Set<string>();
  let running = false;
  let elapsed = 0;
  const commands: string[][] = [];
  const failure = new Error('injected volume copy failure');
  try {
    writeFileSync(join(directory, 'backup.json'), JSON.stringify({
      format: 'command-catalogue-backup-v1', project: 'rezics-catalogue-g1038-source',
      runId: 'source', compatibility: loadCompatibility(root),
    }));
    writeFileSync(join(directory, 'compose.env'), 'ACCOUNT_PORT=3002\n');
    mkdirSync(join(directory, 'objects'));
    writeFileSync(join(directory, 'objects/retained'), 'immutable object');
    if (mode === 'existing-volume') volumes.add(`${project}_${VOLUME_KINDS[1]}`);
    if (mode === 'existing-directory') {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'retained'), 'existing target');
    }
    const operation = restoreCatalogueBackup(join(directory, 'backup.json'), runId, {
      now: () => elapsed,
      dockerEnvironment: () => ({}), projectRunning: () => false,
      freshPorts: async () => ({}),
      run: (_program, args) => {
        commands.push(args);
        if (args[0] === 'volume' && args[1] === 'ls') {
          const name = args.at(-1)!.slice('name=^'.length, -1);
          return volumes.has(name) ? name : '';
        }
        if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args[2]!);
        return '';
      },
      copyVolume: async (_source, destination) => {
        volumes.add(destination);
        if (mode === 'copy-failure') throw failure;
      },
      task: async args => {
        commands.push(args);
        if (args[0] === 'stack:up') {
          running = true;
          if (mode === 'startup-failure') throw new Error('injected startup failure');
          if (mode === 'cleanup-failure') throw failure;
          if (mode === 'budget') elapsed = 600_001;
        }
        if (args[0] === 'stack:reset') {
          running = false;
          if (mode === 'cleanup-failure') throw new Error('injected reset failure');
          volumes.clear();
        }
        return '';
      },
    });
    if (mode === 'success') {
      const restored = await operation;
      expect(running).toBe(true);
      expect(volumes.size).toBe(VOLUME_KINDS.length);
      expect(readFileSync(join(target, 'objects/retained'), 'utf8')).toBe('immutable object');
      await restored.stop();
    } else {
      await expect(operation.catch(error => {
        if (mode === 'copy-failure') expect(error).toBe(failure);
        if (mode === 'cleanup-failure') {
          expect(error).toBeInstanceOf(AggregateError);
          expect(error.cause).toBe(failure);
          expect(error.errors).toHaveLength(2);
        }
        throw error;
      })).rejects.toThrow(mode === 'budget' ? 'exceeded 600 seconds'
        : mode === 'existing-volume' ? 'already has storage'
        : mode === 'existing-directory' ? 'already exists'
        : mode === 'startup-failure' ? 'injected startup failure' : failure.message);
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
test('catalogue restore: exceeding the budget after startup removes the stack, volumes and target', async () => {
  await restoreScenario('budget');
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

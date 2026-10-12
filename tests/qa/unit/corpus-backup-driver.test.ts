import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createCorpusBackupDriver, stopCorpusSourcePostgres,
  type CorpusBackupDriverOptions, type CorpusBackupRuntime } from '../../../scripts/load/corpus-backup-driver.ts';
import { root } from '../../../scripts/fixture/stack.ts';

const signal = () => AbortSignal.timeout(10_000);
const image = `postgres:18.6-trixie@sha256:${'a'.repeat(64)}`;

function shutdownScenario(options: { state?: object; control?: string; stopFailure?: Error } = {}) {
  const commands: { program: string; args: string[]; timeout?: number }[] = [];
  return { commands, dependencies: {
    dockerEnvironment: () => ({}), postgresImage: () => image,
    run: (program: string, args: string[], _env: NodeJS.ProcessEnv, timeout?: number) => {
      commands.push({ program, args, timeout });
      return JSON.stringify(options.state ?? { Status: 'exited', Running: false, ExitCode: 0, OOMKilled: false });
    },
    stream: async (program: string, args: string[], _env: NodeJS.ProcessEnv,
      _input?: AsyncIterable<string>, timeout?: number) => {
      commands.push({ program, args, timeout });
      if (args[0] === 'stop' && options.stopFailure) throw options.stopFailure;
      return args[0] === 'run' ? options.control ?? 'Database cluster state:               shut down\n' : '';
    },
  } };
}

test('corpus capture waits for PostgreSQL exit and verifies its stopped control file read only', async () => {
  const scenario = shutdownScenario();
  await stopCorpusSourcePostgres('retained-source', signal(), scenario.dependencies);
  expect(scenario.commands).toEqual([
    { program: 'docker', args: ['stop', '--timeout', '120', 'rezics-qa-retained-source-postgres-1'], timeout: 150_000 },
    { program: 'docker', args: ['inspect', '--format', '{{json .State}}', 'rezics-qa-retained-source-postgres-1'], timeout: 15_000 },
    { program: 'docker', args: ['run', '--rm', '--network', 'none', '--read-only', '--user', 'postgres',
      '--env', 'LC_ALL=C', '--volume', 'rezics-qa-retained-source_postgres_data:/var/lib/postgresql:ro',
      '--entrypoint', 'pg_controldata', image, '/var/lib/postgresql/18/docker'], timeout: 30_000 },
  ]);
});

test('corpus capture rejects invalid sources and cancellation before any Docker operation', async () => {
  const invalid = shutdownScenario();
  await expect(stopCorpusSourcePostgres('../other-source', signal(), invalid.dependencies))
    .rejects.toThrow('Invalid corpus source run');
  expect(invalid.commands).toEqual([]);
  const cancelled = shutdownScenario();
  const controller = new AbortController();
  controller.abort(new Error('cancelled capture'));
  await expect(stopCorpusSourcePostgres('retained-source', controller.signal, cancelled.dependencies))
    .rejects.toThrow('cancelled capture');
  expect(cancelled.commands).toEqual([]);
});

test('corpus capture rejects running, killed, OOM or unverified PostgreSQL before reading its volume', async () => {
  for (const state of [
    { Status: 'running', Running: true, ExitCode: 0, OOMKilled: false },
    { Status: 'exited', Running: false, ExitCode: 137, OOMKilled: false },
    { Status: 'exited', Running: false, ExitCode: 0, OOMKilled: true },
    { Status: 'exited', Running: false, ExitCode: 0 },
  ]) {
    const scenario = shutdownScenario({ state });
    await expect(stopCorpusSourcePostgres('retained-source', signal(), scenario.dependencies))
      .rejects.toThrow('did not stop cleanly');
    expect(scenario.commands.map(command => command.args[0])).toEqual(['stop', 'inspect']);
  }
});

test('corpus capture rejects crash recovery and incomplete control state even after a zero exit', async () => {
  for (const control of ['Database cluster state: in crash recovery\n',
    'Database cluster state: in production\n', 'Database cluster state: shut down in recovery\n', '']) {
    const scenario = shutdownScenario({ control });
    await expect(stopCorpusSourcePostgres('retained-source', signal(), scenario.dependencies))
      .rejects.toThrow('control file is not shut down');
  }
  const failed = shutdownScenario({ stopFailure: new Error('stop timed out') });
  await expect(stopCorpusSourcePostgres('retained-source', signal(), failed.dependencies))
    .rejects.toThrow('stop timed out');
  expect(failed.commands.map(command => command.args[0])).toEqual(['stop']);
});

function driverScenario(failure?: 'shutdown' | 'capture' | 'migration' | 'smoke') {
  const events: string[] = [];
  const options: CorpusBackupDriverOptions = {
    sourceRunId: 'retained-source', directory: join(root, '.temp/corpus-driver-unit'), resumeSource: false,
    quiesce: async () => { events.push('quiesce'); return async () => { events.push('resume-writer'); }; },
    smokeRead: async () => {
      events.push('smoke');
      if (failure === 'smoke') throw new Error('smoke failed');
      return async () => { events.push('stop-smoke'); };
    },
  };
  const dependencies: Partial<CorpusBackupRuntime> = {
    stopSourcePostgres: async () => {
      events.push('shutdown');
      if (failure === 'shutdown') throw new Error('shutdown unverified');
    },
    retainStoppedOwnerBackup: async (_runId, _id, directory, _startedAt, captureOptions) => {
      events.push('capture');
      expect(captureOptions?.resumeSource).toBe(false);
      if (failure === 'capture') throw new Error('capture failed');
      return join(directory, 'backup.json');
    },
    restoreCatalogueBackup: async () => {
      events.push('restore');
      return { apps: {}, elapsedMs: 0, admissionWaitMs: 0,
        preparation: { restoreMs: 0, startupMs: 0, readinessMs: 0, totalMs: 0 },
        stop: async () => { events.push('reset-copy'); } };
    },
    migrateRestoredCopy: async () => {
      events.push('migration');
      if (failure === 'migration') throw new Error('migration failed');
    },
  };
  return { events, driver: createCorpusBackupDriver(options, dependencies) };
}

test('corpus driver certifies shutdown before capture and keeps retained source storage stopped', async () => {
  const { events, driver } = driverScenario();
  expect(await driver.backup('retained-cut', signal()))
    .toBe(join(root, '.temp/corpus-driver-unit/retained-cut/backup.json'));
  expect(events).toEqual(['quiesce', 'shutdown', 'capture']);
});

test('corpus driver fails closed before capture when shutdown is unverified', async () => {
  const { events, driver } = driverScenario('shutdown');
  await expect(driver.backup('retained-cut', signal())).rejects.toThrow('shutdown unverified');
  // Writer cleanup is distinct from storage startup: uncertified storage remains stopped.
  expect(events).toEqual(['quiesce', 'shutdown', 'resume-writer']);
});

test('corpus driver resumes writer cleanup after capture fails', async () => {
  const { events, driver } = driverScenario('capture');
  await expect(driver.backup('retained-cut', signal())).rejects.toThrow('capture failed');
  expect(events).toEqual(['quiesce', 'shutdown', 'capture', 'resume-writer']);
});

test('corpus driver restores and migrates before smoke readiness, then closes reader and copy once', async () => {
  const { events, driver } = driverScenario();
  await driver.restore('retained-backup', 'independent-copy', signal());
  expect(driver.preparation('independent-copy')).toBeDefined();
  await driver.stop('independent-copy');
  await driver.stop('independent-copy');
  expect(events).toEqual(['restore', 'migration', 'smoke', 'stop-smoke', 'reset-copy']);
  expect(driver.preparation('independent-copy')).toBeUndefined();
});

test('corpus driver resets its isolated restore when migration or smoke readiness fails', async () => {
  for (const failure of ['migration', 'smoke'] as const) {
    const { events, driver } = driverScenario(failure);
    await expect(driver.restore('retained-backup', 'independent-copy', signal())).rejects.toThrow(`${failure} failed`);
    expect(events).toEqual(failure === 'migration'
      ? ['restore', 'migration', 'reset-copy'] : ['restore', 'migration', 'smoke', 'reset-copy']);
    expect(driver.preparation('independent-copy')).toBeUndefined();
  }
});

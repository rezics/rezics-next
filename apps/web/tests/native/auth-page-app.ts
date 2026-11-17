import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, sep } from 'node:path';
import { nativeViteEnvironment } from './vite-environment.ts';
import {
  describeNativeProcessGroup,
  nativeProcessGroupIsGone,
  type NativeProcessOwnership,
  type NativeTestLifecycle,
} from './lifecycle.ts';

type App = {
  owner: NativeProcessOwnership;
  exited: Promise<void>;
  persistenceDirectory?: string;
};

/** The issuer bridge survives each finite Auth UI process. */
export function createNativeAuthPageApp(
  lifecycle: NativeTestLifecycle,
  root: string,
  origin: string,
  environment: NodeJS.ProcessEnv,
) {
  const owned = new Set<App>();
  let resident: App | undefined;
  let opening: Promise<void> | undefined;
  let retiring: Promise<void> | undefined;
  let retirementFailure: unknown;
  let closing = false;
  let stopping: Promise<void> | undefined;

  async function close(app: App) {
    try {
      await app.owner.close();
    } catch {
      await app.owner.force();
    }
    await app.exited;
    if (!nativeProcessGroupIsGone(app.owner.identity))
      throw new Error(
        `Native Auth page app group remained after shutdown: ${describeNativeProcessGroup(app.owner.identity)}`,
      );
    if (app.persistenceDirectory && existsSync(app.persistenceDirectory))
      throw new Error(`Auth Worker left its owned persistence after shutdown: ${app.persistenceDirectory}`);
    if (resident === app) resident = undefined;
    owned.delete(app);
    app.owner.release();
    console.info('Native Auth page app stopped', { pid: app.owner.identity.pid });
  }

  async function launch() {
    if (closing) throw new Error('Native Auth page app is closing');
    lifecycle.assertOpen('start native Auth page app');
    const command = ['bun', 'run', 'dev', '--host', '127.0.0.1', '--port', new URL(origin).port, '--strictPort'];
    const child = spawn('python3', [`${import.meta.dir}/auth-page-app-reaper.py`, ...command], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: nativeViteEnvironment(environment),
    });
    const app: App = {
      owner: lifecycle.ownProcessGroup('native Auth Vite app', child),
      exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
    };
    owned.add(app);
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-12_000)));
    try {
      const deadline = Date.now() + 150_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (closing) throw new Error('Native Auth page app is closing');
        lifecycle.assertOpen('wait for Auth app startup');
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Auth app exited during startup: ${output}`);
        try {
          const response = await fetch(`${origin}/login`, {
            signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(3_000)]),
          });
          if (response.status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(250);
      }
      if (!ready) throw new Error(`Auth app startup timed out: ${output}`);
      const effective = output.match(/\[worker-persistence\]\s+app=auth\s+effective=(\S+)/u)?.[1];
      if (!effective)
        throw new Error(`Native Auth app did not report its effective Worker persistence path: ${output}`);
      const directory = dirname(effective);
      const temporary = realpathSync(tmpdir());
      const actual = realpathSync(directory);
      const within = relative(temporary, actual);
      if (
        within === '' ||
        within === '..' ||
        within.startsWith(`..${sep}`) ||
        dirname(actual) !== temporary ||
        !basename(actual).startsWith('rezics-auth-worker-') ||
        !existsSync(effective)
      )
        throw new Error(`Native Auth app reported an invalid Worker persistence path: ${effective}`);
      app.persistenceDirectory = directory;
      lifecycle.assertOpen('finish native Auth page app startup');
      if (closing) throw new Error('Native Auth page app is closing');
      resident = app;
      console.info('Native Auth page app started', { pid: app.owner.identity.pid });
    } catch (error) {
      await close(app).catch((cleanup) => {
        throw new AggregateError([error, cleanup], 'Native Auth page app startup and cleanup failed');
      });
      throw error;
    }
  }

  return {
    async ensure() {
      if (closing) throw new Error('Native Auth page app is closing');
      if (retiring) await retiring;
      if (retirementFailure) throw retirementFailure;
      lifecycle.assertOpen('serve native Auth page app');
      if (resident) return;
      opening ??= launch().finally(() => {
        opening = undefined;
      });
      await opening;
    },
    retire(eligible: () => boolean): Promise<void> {
      if (closing) return stopping ?? Promise.resolve();
      if (retiring) return retiring;
      const task = (async () => {
        if (opening) await opening;
        if (!eligible()) return;
        const app = resident;
        resident = undefined;
        if (app) await close(app);
      })();
      retiring = task;
      void task.then(
        () => {
          if (retiring === task) retiring = undefined;
        },
        (error) => {
          retirementFailure = error;
          if (retiring === task) retiring = undefined;
        },
      );
      return task;
    },
    async settled() {
      while (opening || retiring) await Promise.all([opening, retiring]);
      if (retirementFailure) throw retirementFailure;
    },
    process() {
      return resident?.owner.identity;
    },
    stop(): Promise<void> {
      closing = true;
      return (stopping ??= (async () => {
        await Promise.allSettled([opening, retiring]);
        const results = await Promise.allSettled([...owned].map(close));
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (retirementFailure && !errors.includes(retirementFailure)) errors.push(retirementFailure);
        if (errors.length) throw new AggregateError(errors, 'Native Auth page app shutdown failed');
      })());
    },
    async force() {
      closing = true;
      await Promise.allSettled([...owned].map((app) => app.owner.force()));
    },
  };
}

import { defaultPolicy } from './policy.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sameProcess, signalProcessIdentity, waitForProcess, type ProcessIdentity } from './process.ts';

export const HOST_UNIT = 'rezics-goal-host.service';
export const VERIFIER_UNIT = 'rezics-goal-verifier.service';
/** Resident units that execute tools/goal continuously and must reload it after cp-sync. */
export const RESIDENT_CODE_UNITS = [HOST_UNIT, VERIFIER_UNIT] as const;
export const SERVICE_UNITS = [
  ...RESIDENT_CODE_UNITS,
  'rezics-goal-maintenance.service',
  'rezics-goal-maintenance.timer',
  'rezics-goal-regenerate.service',
  'rezics-goal-regenerate.timer',
] as const;
export type ServiceCommand = (argv: string[]) => Promise<{ code: number; output: string }>;

/** Commands need the user bus, but never the provider or task identity of the invoking session. */
export const serviceCommand: ServiceCommand = async ([command, ...args]) => {
  const env = Object.fromEntries(
    ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
  const child = Bun.spawn([command!, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: out + err };
};

async function checked(argv: string[], run: ServiceCommand): Promise<string> {
  const result = await run(argv);
  if (result.code !== 0 && !(argv.includes('--property=LoadState') && result.output.trim() === 'not-found'))
    throw new Error(result.output.trim() || `${argv.join(' ')}: exit ${result.code}`);
  return result.output;
}

// systemd unit quoting and EnvironmentFile quoting use different expansion rules.
function quote(value: string, unit = false, command = false): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Service paths and environment values must be single-line strings');
  return (
    '"' +
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/%/g, unit ? '%%' : '%')
      .replace(/\$/g, command ? '$$' : '$') +
    '"'
  );
}

// Path settings such as WorkingDirectory= and EnvironmentFile= take no quotes: a quoted value is read as a relative
// path, and on 2026-11-03 it made every unit fail with "bad unit file setting".
function unitPath(value: string): string {
  if (/[\r\n\0"'\\]/.test(value) || value.trim() !== value)
    throw new Error(`Service paths must not contain line breaks, quotes, backslashes or edge whitespace: ${value}`);
  return value.replace(/%/g, '%%');
}

export type ServiceInstall = {
  mainCheckout: string;
  localConfig: string;
  home?: string;
  path?: string;
  kernelCheckRemote?: string;
  bun?: string;
  unitDirectory?: string;
  user?: string;
  maintenanceBudgetMs?: number;
  regenerationBudgetMs?: number;
};

export async function installService(options: ServiceInstall, run = serviceCommand): Promise<void> {
  const main = resolve(options.mainCheckout);
  const home = options.home ?? homedir();
  const directory = options.unitDirectory ?? join(home, '.config/systemd/user');
  const envFile = join(main, '.temp/goal/goal.env');
  const env = {
    GOAL_MAIN_CHECKOUT: main,
    GOAL_LOCAL_CONFIG: resolve(options.localConfig),
    KERNEL_CHECK_REMOTE: options.kernelCheckRemote ?? process.env.KERNEL_CHECK_REMOTE ?? '',
    PATH: options.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
  };
  const contents =
    Object.entries(env)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join('\n') + '\n';
  quote(main, true);
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, contents, { mode: 0o600 });
  // Also repair permissions on an existing file.
  const { chmodSync } = await import('node:fs');
  chmodSync(envFile, 0o600);
  mkdirSync(directory, { recursive: true });
  const replacements: Record<string, string> = {
    '@CHECKOUT@': unitPath(main),
    '@ENVIRONMENT@': unitPath(envFile),
    '@BUN@': quote(options.bun ?? process.execPath, true, true),
    '@CLI@': quote(join(main, 'tools/goal/src/cli.ts'), true, true),
    '@MAINTENANCE_BUDGET@': String(options.maintenanceBudgetMs ?? defaultPolicy.maintenance.budgetMs),
    '@REGENERATION_BUDGET@': String(options.regenerationBudgetMs ?? defaultPolicy.maintenance.regenerationBudgetMs),
  };
  for (const unit of SERVICE_UNITS) {
    let content = readFileSync(join(import.meta.dir, '../systemd', unit), 'utf8');
    for (const [token, value] of Object.entries(replacements)) content = content.replaceAll(token, () => value);
    writeFileSync(join(directory, unit), content);
  }
  await checked(['systemctl', '--user', 'daemon-reload'], run);
  // cp-sync runs the installer with a minimal environment, where Bun's userInfo() failed ("Failed to look up user
  // unknown") and rolled back the 2026-11-03 bootstrap.
  const user = options.user ?? process.env.USER ?? process.env.LOGNAME ?? userInfo().username;
  await checked(['loginctl', 'enable-linger', user], run);
  // Reject a broken unit before the legacy supervisor stops, so a bad install never leaves no host at all.
  await checked(['systemd-analyze', '--user', 'verify', ...SERVICE_UNITS.map((unit) => join(directory, unit))], run);
  await checked(['systemctl', '--user', 'enable', ...RESIDENT_CODE_UNITS, SERVICE_UNITS[3], SERVICE_UNITS[5]], run);
  await stopLegacySupervisor(join(main, '.temp/goal'), run);
  // Wait for the notify host only after the old supervisor and host have relinquished the socket.
  await checked(['systemctl', '--user', 'start', ...RESIDENT_CODE_UNITS], run);
  await checked(['systemctl', '--user', '--no-block', 'start', SERVICE_UNITS[3], SERVICE_UNITS[5]], run);
  for (const file of ['manager-host-liveness.json', 'manager-host-liveness-retry.json', 'manager-host-restart.json'])
    rmSync(join(main, '.temp/goal', file), { force: true });
}

/** Retire only recorded legacy identities and the named transient unit; never signal a worker group. */
export async function stopLegacySupervisor(directory: string, run = serviceCommand): Promise<void> {
  const unit = 'rezics-goal-supervisor.service';
  const loaded = await checked(['systemctl', '--user', 'show', '--property=LoadState', '--value', unit], run);
  if (loaded.trim() !== 'not-found') await checked(['systemctl', '--user', 'stop', unit], run);
  const lease = join(directory, 'manager-host-supervisor.lease');
  let files: string[] = [];
  try {
    files = readdirSync(lease)
      .filter((file) => file.endsWith('.json'))
      .map((file) => join(lease, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The supervisor lease records its own identity; the liveness journal records the old host's identity.
  files.push(join(directory, 'manager-host-liveness.json'));
  for (const file of files) {
    let record;
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const identity = (record.identity ?? record) as ProcessIdentity;
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      typeof identity.start !== 'string' ||
      typeof identity.boot !== 'string' ||
      !Number.isSafeInteger(identity.group) ||
      identity.group <= 0
    )
      throw new Error(`Invalid legacy process identity in ${file}`);
    if (!(await signalProcessIdentity(identity, 'SIGTERM'))) continue;
    await waitForProcess(identity, AbortSignal.timeout(30_000));
    if (sameProcess(identity)) throw new Error(`Legacy process ${identity.pid} did not stop`);
  }
  rmSync(lease, { recursive: true, force: true });
}

export async function reportServices(
  action: 'status' | 'restart' | 'logs',
  run = serviceCommand,
  print: (value: string) => void = console.log,
  policy = defaultPolicy.service,
): Promise<number> {
  let failed = false;
  if (action === 'restart') {
    const restarted = await run(['systemctl', '--user', 'restart', ...RESIDENT_CODE_UNITS]);
    failed = restarted.code !== 0;
    if (restarted.output.trim()) print(restarted.output.trim());
    const timers = await run(['systemctl', '--user', '--no-block', 'restart', SERVICE_UNITS[3], SERVICE_UNITS[5]]);
    failed ||= timers.code !== 0;
    if (timers.output.trim()) print(timers.output.trim());
  }
  for (const unit of SERVICE_UNITS) {
    const health = await run([
      'systemctl',
      '--user',
      'show',
      unit,
      '--no-pager',
      '--property=Id,LoadState,ActiveState,SubState,Result,MainPID,NRestarts,WatchdogTimestamp,NextElapseUSecRealtime',
    ]);
    print(`${unit}\n${health.output.trim()}`);
    failed ||=
      health.code !== 0 ||
      /^(LoadState=not-found|ActiveState=failed|Result=(?!success\b)\S+)/m.test(health.output) ||
      (unit !== SERVICE_UNITS[2] &&
        unit !== SERVICE_UNITS[4] &&
        /^ActiveState=(inactive|deactivating)$/m.test(health.output));
    if (action === 'logs') {
      const logs = await run(['journalctl', '--user', '--unit', unit, '--no-pager', `--lines=${policy.logLines}`]);
      print(logs.output.trim());
      failed ||= logs.code !== 0;
    }
  }
  return failed ? 1 : 0;
}

async function socketReady(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/** A CLI can request activation; only systemd owns the host's lifetime and restart policy. */
export async function ensureServiceHost(
  socket: string,
  run = serviceCommand,
  policy = defaultPolicy.service,
): Promise<void> {
  if (await socketReady(socket, policy.socketTimeoutMs)) return;
  await checked(['systemctl', '--user', 'start', HOST_UNIT], run);
  if (!(await socketReady(socket, policy.socketTimeoutMs)))
    throw new Error(`Manager host socket unavailable after starting ${HOST_UNIT}: ${socket}`);
}

/** Notifications come from this event loop, so an unresponsive host cannot keep its watchdog alive. */
export async function startHostHeartbeat(
  env = process.env,
  notify: ((message: string) => Promise<void>) | undefined = undefined,
  policy = defaultPolicy.service,
): Promise<() => void> {
  notify ??= async (message) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('systemd-notify', [`--pid=${process.pid}`, message], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      child.stderr?.on('data', (chunk) => {
        error = (error + chunk).slice(-policy.diagnosticCharacters);
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(error || `systemd-notify: exit ${code}`)),
      );
    });
  };
  if (!env.NOTIFY_SOCKET) return () => {};
  await notify('READY=1');
  const watchdog = Number(env.WATCHDOG_USEC);
  if (!Number.isFinite(watchdog) || watchdog <= 0) throw new Error('Systemd watchdog interval is missing or invalid');
  let sending = false;
  const timer = setInterval(
    () => {
      if (sending) return;
      sending = true;
      void notify('WATCHDOG=1')
        .catch((error) => console.error(error))
        .finally(() => {
          sending = false;
        });
    },
    // systemd supplies microseconds; notify twice per watchdog interval in milliseconds.
    Math.max(1, Math.floor(watchdog / 2000)),
  );
  timer.unref();
  return () => clearInterval(timer);
}

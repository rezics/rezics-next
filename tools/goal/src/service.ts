import { defaultPolicy } from './policy.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const HOST_UNIT = 'rezics-goal-host.service';
export const SERVICE_UNITS = [
  HOST_UNIT,
  'rezics-goal-verifier.service',
  'rezics-goal-maintenance.service',
  'rezics-goal-maintenance.timer',
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
  if (result.code !== 0) throw new Error(result.output.trim() || `${argv.join(' ')}: exit ${result.code}`);
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

export type ServiceInstall = {
  mainCheckout: string;
  localConfig: string;
  home?: string;
  path?: string;
  kernelCheckRemote?: string;
  bun?: string;
  unitDirectory?: string;
  user?: string;
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
    '@CHECKOUT@': quote(main, true),
    '@ENVIRONMENT@': quote(envFile, true),
    '@BUN@': quote(options.bun ?? process.execPath, true, true),
    '@CLI@': quote(join(main, 'tools/goal/src/cli.ts'), true, true),
  };
  for (const unit of SERVICE_UNITS) {
    let content = readFileSync(join(import.meta.dir, '../systemd', unit), 'utf8');
    for (const [token, value] of Object.entries(replacements)) content = content.replaceAll(token, () => value);
    writeFileSync(join(directory, unit), content);
  }
  await checked(['systemctl', '--user', 'daemon-reload'], run);
  await checked(['loginctl', 'enable-linger', options.user ?? userInfo().username], run);
  await checked(['systemctl', '--user', 'enable', '--now', HOST_UNIT, SERVICE_UNITS[1], SERVICE_UNITS[3]], run);
  await checked(['systemctl', '--user', 'start', SERVICE_UNITS[2]], run);
  // No legacy supervisor is launched or signalled during installation.
  for (const file of ['manager-host-liveness.json', 'manager-host-liveness-retry.json', 'manager-host-restart.json'])
    rmSync(join(main, '.temp/goal', file), { force: true });
}

export async function reportServices(
  action: 'status' | 'restart' | 'logs',
  run = serviceCommand,
  print: (value: string) => void = console.log,
  policy = defaultPolicy.service,
): Promise<number> {
  let failed = false;
  if (action === 'restart') {
    const restarted = await run(['systemctl', '--user', 'restart', ...SERVICE_UNITS]);
    failed = restarted.code !== 0;
    if (restarted.output.trim()) print(restarted.output.trim());
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
      (unit !== 'rezics-goal-maintenance.service' && /^ActiveState=(inactive|deactivating)$/m.test(health.output));
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

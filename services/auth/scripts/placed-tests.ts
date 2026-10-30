import { withTestDatabaseLane } from './database.ts';

type ChildOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};
type Lane = typeof withTestDatabaseLane;
const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/**
 * Run an explicit native selector in a new module graph and a fresh copy of the check's template.
 * The caller already owns a check lane and its stack slot. Do not place it remotely or acquire another slot.
 * The command, executable and caller cwd are preserved, including absolute files and name filters.
 * The optional lane implementation lets runner tests exercise process outcomes without a database service.
 */
export async function runPlacedTests(
  command: string[],
  options: ChildOptions = {},
  withLane: Lane = withTestDatabaseLane,
): Promise<{ code: number; output: string }> {
  return withLane(options.env ?? process.env, async (env) => {
    const child = Bun.spawn(command, {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    let outcome: number | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const stop = (code: number) => {
      outcome ??= code;
      killGroup('SIGTERM');
      escalation ??= setTimeout(() => killGroup('SIGKILL'), 1_000);
    };
    const forwarders = Object.entries(signals).map(([signal, number]) => {
      const forward = () => stop(128 + number);
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    const timeout = setTimeout(() => stop(124), options.timeout ?? 120_000);
    try {
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const code = await child.exited;
      // A failed test can leave a worker or an open output pipe behind. End that tree before dropping its lane.
      killGroup('SIGKILL');
      const output = (await stdout) + (await stderr);
      return { code: outcome ?? code, output };
    } finally {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      for (const [signal, forward] of forwarders) process.off(signal, forward);
      killGroup('SIGKILL');
      await child.exited;
    }
  });
}

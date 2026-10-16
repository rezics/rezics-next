import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { admissionCpuLimit, admissionCpuPressure, admissionHostLoad } from './memory-admission.ts';
import { processStartTime } from './process/identity.ts';

export interface CpuAdmissionOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  deadline: number;
  stateFile?: string;
  processors?: number;
  readPressure?: () => number | undefined;
  readLoad?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  announce?: (message: string) => void;
}

/** Each compiler uses eight threads. Keep half the host for tests and stacks;
 * even a small host can run one compiler when its pressure permits it. */
export function cpuCommandLimit(processors: number): number {
  if (!Number.isSafeInteger(processors) || processors < 1) throw new Error('Invalid host CPU count');
  return Math.max(1, Math.floor(processors / 16));
}

/** All checkouts share lifetime permits, closing the gap before a burst of
 * compiler starts becomes visible in the kernel's ten-second pressure signal. */
export async function withCpuAdmission<T>(options: CpuAdmissionOptions, run: () => Promise<T>): Promise<T> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const announce = options.announce ?? console.error;
  const processors = options.processors ?? availableParallelism();
  const capacity = cpuCommandLimit(processors);
  const path = options.stateFile ?? '/tmp/rezics-heavy-cpu-admission.sqlite';
  mkdirSync(dirname(path), { recursive: true });
  const state = new Database(path, { create: true });
  state.exec('PRAGMA busy_timeout = 1000');
  state.exec(`CREATE TABLE IF NOT EXISTS cpu_commands (
    id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL
  )`);
  const id = randomUUID();
  const identity = processStartTime(process.pid);
  let admitted = false;
  let waiting = false;
  const started = now();
  let lastAnnouncement = -Infinity;
  try {
    if (!identity) throw new Error('Cannot identify CPU admission owner');
    while (!admitted) {
      const pressure = options.readPressure ? options.readPressure() : admissionCpuPressure({ env });
      const limit = await admissionCpuLimit({ root: options.root, env, deadline: options.deadline }, pressure !== undefined);
      const load = pressure === undefined ? (options.readLoad ?? (() => admissionHostLoad(env)))() : undefined;
      const pressureFits = pressure === undefined ? load! / processors <= limit : pressure <= limit;
      let active = 0;
      state.transaction(() => {
        for (const owner of state.query<{ id: string; pid: number; start_time: string }, []>('SELECT * FROM cpu_commands').all()) {
          if (processStartTime(owner.pid) !== owner.start_time)
            state.query('DELETE FROM cpu_commands WHERE id = ?').run(owner.id);
          else active++;
        }
        if (active < capacity && pressureFits && now() < options.deadline) {
          state.query('INSERT INTO cpu_commands (id, pid, start_time) VALUES (?, ?, ?)').run(id, process.pid, identity);
          admitted = true;
        }
      }).immediate();
      const signal = pressure === undefined
        ? `CPU pressure unavailable; load ${load!.toFixed(2)}/${processors}, limit ${limit}`
        : `CPU pressure some avg10 ${pressure.toFixed(2)}%, limit ${limit}%`;
      if (admitted) {
        announce(`CPU admitted: ${active + 1}/${capacity} heavy commands; ${signal}; waited ${((now() - started) / 1000).toFixed(1)}s`);
        break;
      }
      const message = `Waiting for CPU admission: ${active}/${capacity} heavy commands; ${signal}`;
      if (now() >= options.deadline) throw new Error(`CPU admission deadline reached; ${message}; no work started`);
      if (!waiting || now() - lastAnnouncement >= 10_000) {
        announce(message);
        waiting = true;
        lastAnnouncement = now();
      }
      await sleep(Math.min(options.pollMs ?? 1000, options.deadline - now()));
    }
    return await run();
  } finally {
    if (admitted) state.query('DELETE FROM cpu_commands WHERE id = ?').run(id);
    state.close();
  }
}

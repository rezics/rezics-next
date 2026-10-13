import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

/** A manager's turn is cut after its minutes and its process group is killed; a landing's gates outlast it. */
export function landsOutsideTurn(env: Env): boolean {
  return Boolean(env.GOAL_TURN_TOKEN) && !env.GOAL_TASK_ID;
}

/** The turn's token marks what a cut kills: the landing must not carry it. */
export function landingEnv(env: Env): Env {
  const { GOAL_TURN_TOKEN: _token, GOAL_TURN_STATE_DIR: _state, ...rest } = env;
  return rest;
}

export interface OutsideLanding {
  id: string;
  step: boolean;
  /** `.temp/goal-orchestration/runs/<id>`: the log stays beside the landing's lock. */
  runDir: string;
  root: string;
  script: string;
  env: Env;
  start?: typeof spawn;
}

/** Starts the same command in its own session and returns what the turn should read. */
export function startLandingOutsideTurn(options: OutsideLanding): string {
  mkdirSync(options.runDir, { recursive: true });
  const logPath = join(options.runDir, 'land.log');
  const log = openSync(logPath, 'a');
  try {
    const child = (options.start ?? spawn)(process.execPath,
      [options.script, 'land', options.id, ...(options.step ? ['--step'] : []), '--report'],
      { cwd: options.root, detached: true, stdio: ['ignore', log, log], env: landingEnv(options.env) });
    if (!child.pid) throw new Error(`${options.id}: landing did not start`);
    child.unref();
    return `${options.id}: landing started outside this turn (pid ${child.pid}). Its result is mailed to this Goal; `
      + `do not wait for it and do not start it again. Log: ${logPath}`;
  } finally { closeSync(log); }
}

const REPORT_LIMIT = 1500;

/** The landing's end reaches its Goal as mail, so a later turn closes the task or resumes its worker. */
export async function reportLanding(id: string, step: boolean, land: () => Promise<void>,
  send: (body: string, key: string) => void, now: () => number = Date.now): Promise<number> {
  const command = `land ${id}${step ? ' --step' : ''}`;
  let body: string;
  let code = 0;
  try {
    await land();
    body = `\`${command}\` succeeded. If ${id} is still open, close it (\`close ${id} verified\`) when nothing is left of its brief, or resume its worker.`;
  } catch (error) {
    code = 1;
    const reason = error instanceof Error ? error.message : String(error);
    console.error(reason);
    body = `\`${command}\` did not land: ${reason.length > REPORT_LIMIT ? `${reason.slice(0, REPORT_LIMIT)} …` : reason}`;
  }
  send(body, `land-${id}-${now()}`);
  return code;
}

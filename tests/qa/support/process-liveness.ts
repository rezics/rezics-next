import { readFileSync } from 'node:fs';

/** Reaping can move a task from Z to X between reads; neither state can run work. */
export function processRunning(pid: number, readStat = (path: string) => readFileSync(path, 'utf8')): boolean {
  let stat: string;
  try { stat = readStat(`/proc/${pid}/stat`); }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  // comm may contain spaces and parentheses, so the state follows its final closing parenthesis.
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  if (!state) throw new Error(`Missing process state for pid ${pid}`);
  return state !== 'Z' && state !== 'X';
}

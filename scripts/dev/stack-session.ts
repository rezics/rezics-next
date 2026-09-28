import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseOptions, projectName, type StackOptions } from './config.ts';

const sessionFile = (root: string) => join(root, '.temp', 'dev-stacks.json');

/** Remember each isolated backend this checkout started, including custom run IDs.
 * Starting a frontend later must not forget a backend still holding containers. */
export function startedDevStacks(root: string): StackOptions[] {
  const path = sessionFile(root);
  if (!existsSync(path)) return [];
  const saved = JSON.parse(readFileSync(path, 'utf8')) as string[][];
  return saved.map(args => {
    const options = parseOptions(args);
    if (options.profile !== 'qa') throw new Error('A recorded isolated dev stack must use the QA profile');
    projectName(options);
    return options;
  });
}

function save(root: string, stacks: StackOptions[]): void {
  const path = sessionFile(root);
  if (!stacks.length) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true });
  const args = stacks.map(options => ['--profile', 'qa', '--run-id', options.runId!,
    ...(options.persistent ? ['--persistent'] : []), ...(options.rawUpdate ? ['--raw-update'] : []),
    ...(options.accountsApp ? ['--accounts-app'] : [])]);
  writeFileSync(`${path}.tmp`, JSON.stringify(args), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function rememberDevStack(root: string, options: StackOptions): void {
  if (options.profile !== 'qa') throw new Error('Only isolated dev stacks are recorded');
  const project = projectName(options);
  save(root, [...startedDevStacks(root).filter(stack => projectName(stack) !== project), options]);
}

/** Forget only after successful cleanup, so a failed stop remains retryable. */
export function forgetDevStack(root: string, options: StackOptions): void {
  save(root, startedDevStacks(root).filter(stack => projectName(stack) !== projectName(options)));
}

export function devStackStopArgs(options: StackOptions): string[] {
  return ['down', ...options.persistent ? [] : ['--volumes'], '--remove-orphans'];
}

export function stopDevSession(root: string, stopHost: () => void,
  stopStack: (options: StackOptions) => void, explicit?: StackOptions): void {
  let hostError: unknown;
  try { stopHost(); } catch (error) { hostError = error; }
  // A failed/partially started AppHost must not strand its storage containers.
  const stacks = startedDevStacks(root);
  if (explicit && !stacks.some(stack => projectName(stack) === projectName(explicit))) stacks.push(explicit);
  for (const stack of stacks) {
    stopStack(stack);
    forgetDevStack(root, stack);
  }
  if (hostError) throw hostError;
}

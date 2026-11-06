import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Generated Paraglide output is current when it is at least as new as every message catalogue. */
export function messagesCurrent(appDirectory: string): boolean {
  const messagesDirectory = join(appDirectory, 'messages');
  const output = join(appDirectory, 'src/paraglide/messages.js');
  const index = join(appDirectory, 'src/paraglide/messages/_index.js');
  if (!existsSync(output) || !existsSync(index)) return false;
  const outputTime = statSync(output).mtimeMs;
  const messageFiles = readdirSync(messagesDirectory).filter((name) => name.endsWith('.json'));
  const newestMessageTime = messageFiles.reduce(
    (newest, name) => Math.max(newest, statSync(join(messagesDirectory, name)).mtimeMs),
    Number.NEGATIVE_INFINITY,
  );
  if (outputTime < newestMessageTime) return false;

  const indexDirectory = dirname(index);
  const references = readFileSync(index, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/gu);
  for (const [, reference] of references) {
    if (!reference?.startsWith('.')) continue;
    if (!existsSync(resolve(indexDirectory, reference))) return false;
  }
  return true;
}

export function ensureMessagesReady(appDirectory: string, env: NodeJS.ProcessEnv = process.env): number {
  if (messagesCurrent(appDirectory)) return 0;

  return Bun.spawnSync(['bun', 'run', 'generate'], {
    cwd: appDirectory,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).exitCode;
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const generatedMessages = 'src/paraglide/messages.js';
const generatedLeaves = 'src/paraglide/messages';

function catalogueMessageIds(messagesDirectory: string): string[] {
  const ids = new Set<string>();
  for (const name of readdirSync(messagesDirectory).filter((entry) => entry.endsWith('.json'))) {
    const parsed: unknown = JSON.parse(readFileSync(join(messagesDirectory, name), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const key of Object.keys(parsed)) ids.add(key);
  }
  return [...ids];
}

/** Generated Paraglide output is current only when messages.js and every catalogue leaf exist and are at least as new as the catalogues. */
export function messagesCurrent(appDirectory: string): boolean {
  const messagesDirectory = join(appDirectory, 'messages');
  const output = join(appDirectory, generatedMessages);
  if (!existsSync(output)) return false;
  const outputTime = statSync(output).mtimeMs;
  const messageFiles = readdirSync(messagesDirectory).filter((name) => name.endsWith('.json'));
  const newestMessageTime = messageFiles.reduce(
    (newest, name) => Math.max(newest, statSync(join(messagesDirectory, name)).mtimeMs),
    Number.NEGATIVE_INFINITY,
  );
  if (outputTime < newestMessageTime) return false;
  const leafDirectory = join(appDirectory, generatedLeaves);
  for (const id of catalogueMessageIds(messagesDirectory)) {
    const leaf = join(leafDirectory, `${id}.js`);
    if (!existsSync(leaf) || statSync(leaf).mtimeMs < newestMessageTime) return false;
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

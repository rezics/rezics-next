import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function ensureMessagesReady(appDirectory: string, env: NodeJS.ProcessEnv = process.env): number {
  const messagesDirectory = join(appDirectory, 'messages');
  const output = join(appDirectory, 'src/paraglide/messages.js');
  if (existsSync(output)) {
    const outputTime = statSync(output).mtimeMs;
    const messageFiles = readdirSync(messagesDirectory).filter((name) => name.endsWith('.json'));
    const newestMessageTime = messageFiles.reduce(
      (newest, name) => Math.max(newest, statSync(join(messagesDirectory, name)).mtimeMs),
      Number.NEGATIVE_INFINITY,
    );
    if (outputTime >= newestMessageTime) return 0;
  }

  return Bun.spawnSync(['bun', 'run', 'generate'], {
    cwd: appDirectory,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).exitCode;
}

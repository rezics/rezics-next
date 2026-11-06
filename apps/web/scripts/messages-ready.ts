import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PARAGLIDE = 'src/paraglide';
const PER_MESSAGE_IMPORT = /(?:from|import)\s+['"](\.\/messages\/[^'"]+)['"]/g;
/** Vite failed after a partial compile with this exact module missing. */
export const REQUIRED_PER_MESSAGE_MODULE = 'access_account.js';

/** Relative `./messages/...` modules that the generated barrel imports. */
export function generatedMessageModules(source: string): string[] {
  const modules = new Set<string>();
  PER_MESSAGE_IMPORT.lastIndex = 0;
  for (const match of source.matchAll(PER_MESSAGE_IMPORT)) {
    const specifier = match[1]!;
    modules.add(specifier.endsWith('.js') ? specifier : `${specifier}.js`);
  }
  return [...modules];
}

function catalogueMessageIds(messagesDirectory: string): string[] {
  if (!existsSync(messagesDirectory)) return [];
  const ids = new Set<string>();
  for (const name of readdirSync(messagesDirectory).filter((entry) => entry.endsWith('.json'))) {
    const parsed: unknown = JSON.parse(readFileSync(join(messagesDirectory, name), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    for (const key of Object.keys(parsed)) ids.add(key);
  }
  return [...ids];
}

function newestCatalogueTime(appDirectory: string): number {
  const messagesDirectory = join(appDirectory, 'messages');
  if (!existsSync(messagesDirectory)) return Number.NEGATIVE_INFINITY;
  return readdirSync(messagesDirectory)
    .filter((name) => name.endsWith('.json'))
    .reduce(
      (newest, name) => Math.max(newest, statSync(join(messagesDirectory, name)).mtimeMs),
      Number.NEGATIVE_INFINITY,
    );
}

function fileTime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Generated Paraglide output is current when the barrel, runtime, imported modules and every catalogue leaf are at
 * least as new as every catalogue. A barrel without `messages/access_account.js` is not current: Vite then serves
 * nothing at /en and SSR imports fail ENOENT.
 */
export function messagesCurrent(appDirectory: string): boolean {
  const outputDirectory = join(appDirectory, PARAGLIDE);
  const barrel = join(outputDirectory, 'messages.js');
  const runtime = join(outputDirectory, 'runtime.js');
  const barrelTime = fileTime(barrel);
  const runtimeTime = fileTime(runtime);
  if (barrelTime === undefined || runtimeTime === undefined) return false;
  const newestMessageTime = newestCatalogueTime(appDirectory);
  if (Math.min(barrelTime, runtimeTime) < newestMessageTime) return false;

  const source = readFileSync(barrel, 'utf8');
  const modules = [
    ...generatedMessageModules(source),
    ...catalogueMessageIds(join(appDirectory, 'messages')).map((id) => `./messages/${id}.js`),
  ];
  const perMessageDirectory = join(outputDirectory, 'messages');
  const required =
    existsSync(perMessageDirectory) && statSync(perMessageDirectory).isDirectory()
      ? [...new Set([...modules, `./messages/${REQUIRED_PER_MESSAGE_MODULE}`])]
      : modules;
  for (const relative of required) {
    const path = join(outputDirectory, relative);
    const time = fileTime(path);
    if (time === undefined || time < newestMessageTime) return false;
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

import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { runImageCommand, type FusekiImageOptions } from '../dev/fuseki-image-build.ts';
import { fusekiDockerfile } from '../dev/fuseki-image.ts';

/** The original Maven package invocation lives in Docker's module-test target.
 * BuildKit's successful layer is reusable at a wave tip; the runtime image never depends on it. */
export async function runNativeModuleSuite(root: string, options: FusekiImageOptions = {}): Promise<void> {
  const directory = join(root, '.temp/native-module-suite');
  mkdirSync(directory, { recursive: true });
  const log = join(directory, `${randomUUID()}.log`);
  const output = openSync(log, 'w', 0o600);
  try {
    await runImageCommand(root, [options.docker ?? 'docker', 'build', '--progress', 'plain',
      '--target', 'module-test', '--file', join(root, fusekiDockerfile), root],
    { ...options, budgetMs: options.budgetMs ?? 45 * 60_000, output });
    console.log(`Native module suite passed; output in ${log}`);
  } catch (error) {
    const tail = readFileSync(log, 'utf8').slice(-6000);
    throw new Error(`Native module suite failed; output in ${log}\n${tail}`, { cause: error });
  } finally { closeSync(output); }
}

if (import.meta.main) await runNativeModuleSuite(resolve(import.meta.dir, '../..'));

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { runImageCommand, type FusekiImageOptions } from '../dev/fuseki-image-build.ts';
import { fusekiDockerfile, fusekiImageTag } from '../dev/fuseki-image.ts';

export interface NativeModuleSuiteOptions extends FusekiImageOptions {
  /** Exact Surefire class names, optionally qualified and/or followed by #method+method. */
  tests?: string;
}

export function validateNativeTestSelection(selection: string): string {
  const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';
  const selector = `${identifier}(?:\\.${identifier})*(?:#${identifier}(?:\\+${identifier})*)?`;
  if (!selection || selection.length > 4096 || /[^A-Za-z0-9_$.,#+]/u.test(selection)
    || !new RegExp(`^${selector}(?:,${selector})*$`, 'u').test(selection)
    || selection.split(',').some(part => /\.(?:java|class)(?:#|$)/u.test(part))) {
    throw new Error('Invalid native test selection: use exact Class[#method[+method]][,Class...] names; flags, paths and patterns are not allowed');
  }
  return selection;
}

export function parseNativeModuleSuiteArgs(args: readonly string[]): NativeModuleSuiteOptions {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== '--tests') throw new Error('usage: task jena:test -- --tests Class[#method][,Class...]');
  return { tests: validateNativeTestSelection(args[1]!) };
}

function sourceRecord(root: string) {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const repository = git(['rev-parse', '--show-toplevel']);
  // Synthetic command-test contexts have no Git revision or complete image inputs.
  let inputTag: string | null = null;
  try { inputTag = fusekiImageTag(root); } catch { /* The context path is still recorded. */ }
  return { root, revision: repository === resolve(root) ? git(['rev-parse', 'HEAD']) : null,
    status: repository === resolve(root) ? git(['status', '--porcelain=v1', '--untracked-files=all']) : null, inputTag };
}

/** The original Maven package invocation lives in Docker's module-test target.
 * BuildKit's successful layer is reusable at a wave tip; the runtime image never depends on it. */
export async function runNativeModuleSuite(root: string, options: NativeModuleSuiteOptions = {}): Promise<void> {
  const selection = options.tests === undefined ? null : validateNativeTestSelection(options.tests);
  const directory = join(root, '.temp/native-module-suite');
  mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  const log = join(directory, `${id}.log`);
  const record = join(directory, `${id}.json`);
  const budgetMs = options.budgetMs ?? 45 * 60_000;
  const command = [options.docker ?? 'docker', 'build', '--progress', 'plain', '--target', 'module-test'];
  if (selection !== null) {
    command.push('--build-arg', `NATIVE_TEST_SELECTION=${selection}`, '--build-arg',
      `NATIVE_TEST_CACHE_ID=rezics-native-test-files-selected-${createHash('sha256').update(selection).digest('hex')}`);
  }
  command.push('--file', join(root, fusekiDockerfile), root);
  const metadata = { source: sourceRecord(root), selection, scope: selection === null ? 'full' : 'selected',
    result: 'running', startedAt: new Date().toISOString(), finishedAt: null as string | null,
    budgetMs, command, log, error: null as string | null };
  const save = () => writeFileSync(record, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  save();
  const output = openSync(log, 'w', 0o600);
  const label = selection === null ? 'Native module suite' : `Selected native tests (${selection}; not a full-suite pass)`;
  try {
    await runImageCommand(root, command, { ...options, budgetMs, output });
    metadata.result = 'passed';
    console.log(`${label} passed; output in ${log}; record in ${record}`);
  } catch (error) {
    metadata.result = 'failed';
    metadata.error = error instanceof Error ? error.message : String(error);
    const tail = readFileSync(log, 'utf8').slice(-6000);
    throw new Error(`${label} failed; output in ${log}; record in ${record}\n${tail}`, { cause: error });
  } finally {
    closeSync(output);
    metadata.finishedAt = new Date().toISOString();
    save();
  }
}

if (import.meta.main) await runNativeModuleSuite(resolve(import.meta.dir, '../..'), parseNativeModuleSuiteArgs(process.argv.slice(2)));

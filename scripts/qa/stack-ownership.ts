import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOptions, projectName, type StackOptions } from '../dev/config.ts';
import { recordedStackArgs } from '../dev/stack-session.ts';

export const QA_STACK_REGISTRY = 'REZICS_QA_STACK_REGISTRY';
export const QA_STACK_TIER = 'REZICS_QA_STACK_TIER';

/** Integration uses owner endpoints directly. Fault drills and manual stacks
 * keep the complete topology, including the network fault proxy. */
export function qaStartupServices(options: StackOptions, tier: string | undefined): string[] {
  return options.profile === 'qa' && tier === 'integration'
    ? ['postgres', 'fuseki', 'rustfs', 'mailpit'] : [];
}

/** The runner owns child-created stacks too: a killed test cannot run finally. */
export function rememberQaStack(options: StackOptions, directory = process.env[QA_STACK_REGISTRY]): void {
  if (!directory) return;
  if (options.profile !== 'qa') throw new Error('A QA child may only start QA stacks');
  const project = projectName(options);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${project}.json`), JSON.stringify(recordedStackArgs(options)),
    { mode: 0o600 });
}

export function forgetQaStack(options: StackOptions, directory = process.env[QA_STACK_REGISTRY]): void {
  if (directory) rmSync(join(directory, `${projectName(options)}.json`), { force: true });
}

/** Attempt every reset; keep failed records for the runner's final cleanup. */
export async function cleanupQaStacks(directory: string,
  reset: (args: string[]) => Promise<void>): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const errors: string[] = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json')).sort()) {
    try {
      const args = JSON.parse(readFileSync(join(directory, file), 'utf8')) as string[];
      const options = parseOptions(args);
      if (options.profile !== 'qa' || file !== `${projectName(options)}.json`) {
        throw new Error('Invalid QA stack ownership record');
      }
      await reset(args);
      forgetQaStack(options, directory);
    } catch (error) { errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return errors;
}

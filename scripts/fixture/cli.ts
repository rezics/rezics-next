import { restoreLoadBaseline } from '../load/restore.ts';
import { buildFixture } from './build.ts';
import { checkedSeed, DEFAULT_SEED, type FixtureProfile, PROFILES } from './corpus.ts';
import { restoreFixture } from './restore.ts';

const usage = `Usage:
  task fixture:build -- --profile small|medium [--seed <seed>]
  task fixture:restore -- --fixture <fixture-id> --run-id <fixture-target-id>
  task fixture:restore -- --from <load-source-id> --run-id <fixture-target-id>`;

function options(args: string[], allowed: Record<string, RegExp>): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '') ?? '';
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !allowed[name] || value === undefined
      || !allowed[name].test(value) || Object.hasOwn(values, name)) {
      throw new Error(`Invalid option ${args[index] ?? ''}\n${usage}`);
    }
    values[name] = value;
  }
  return values;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'build') {
    const values = options(args, { profile: /^(small|medium)$/, seed: /^[a-z0-9][a-z0-9-]{0,39}$/ });
    if (!values.profile || !Object.hasOwn(PROFILES, values.profile)) throw new Error(usage);
    await buildFixture(values.profile as FixtureProfile, checkedSeed(values.seed ?? DEFAULT_SEED));
  } else if (command === 'restore') {
    const values = options(args, { fixture: /^fx-(small|medium)-[0-9a-f]{12}$/,
      from: /^load-[a-z0-9-]{1,30}$/, 'run-id': /^fixture-[a-z0-9-]{1,27}$/ });
    if (!values['run-id'] || Boolean(values.fixture) === Boolean(values.from)) throw new Error(usage);
    if (values.fixture) {
      const evidence = await restoreFixture(values.fixture, values['run-id']);
      console.log(`Restored ${evidence.fixture} as rezics-qa-${evidence.target} in ${evidence.elapsedMs} ms`);
    } else await restoreLoadBaseline(values.from!, values['run-id']);
  } else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

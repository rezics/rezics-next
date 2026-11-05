#!/usr/bin/env bun
/**
 * TEST ONLY: a green verifier proves an executable specification is correctly
 * red, never that product permissions work. Product acceptance runs the suite
 * itself with a real driver. No driver is installed or simulated here.
 *
 * Usage: bun specs/support/verify-outcome-suite.ts <suite.test.ts>
 *   [DRIVER_ENV_VARIABLE "exact missing-driver message"]
 * Other suites use literal test/it names; every declared scenario must run red.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const permissionScenarios = [
  'actor grant AND consented scope AND principal grant permit the same action and resource',
  'revoking only the actor grant denies',
  'revoking only client consent denies an already authenticated request',
  'revoking only the principal grant denies',
  'an actor grant for a different actor does not match',
  'an actor grant for a different resource does not match',
  'a principal grant for a different actor does not match',
  'a principal grant for a different resource does not match',
  'a different actor grant action does not match',
  'a different principal grant action does not match',
  'a different consented scope does not match',
  'consent for another actor or client does not match',
  'without a principal actor grants and consent suffice',
  'operator rights never automatically grant agent rights',
  'unknown actions fail closed',
  'missing authoritative evidence fails closed',
  'unresolved authoritative evidence fails closed',
  'suspended and deleted actors fail closed',
  'raising minimum authn_epoch rejects the stale session',
  'active explicit denies override each account grant',
  'first-party preconsent supplies no resource grant',
  'requested_by must reference a request created by that principal',
  'an actor cannot self-assert a principal instead of a request reference',
  'an actor cannot use a request assigned to another actor',
  'untrusted identity client principal and scope cannot expand authenticated authority',
  'each grant starts inclusively and expires at the exact authoritative end',
  'future and expired denies do not block but an active deny does',
  'organizations cannot be authenticated actors',
  'organization-role grants require an eligible human member with the specified role',
  'grant administration cannot delegate actions the grantor lacks',
];
const maximumTimerDelayMs = 2_147_483_647;

export function getOutcomeTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.VERIFY_OUTCOME_TIMEOUT_MS;
  if (value === undefined) return 120_000;
  const timeoutMs = Number(value);
  requireThat(
    /^[1-9]\d*$/.test(value) && Number.isSafeInteger(timeoutMs),
    `Invalid VERIFY_OUTCOME_TIMEOUT_MS value ${JSON.stringify(value)}: expected a positive integer`,
  );
  return timeoutMs;
}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

async function verify() {
  const timeoutMs = getOutcomeTimeoutMs(process.env);
  const args = process.argv.slice(2);
  requireThat(
    args.length === 1 || args.length === 3,
    'Expected <suite> [DRIVER_ENV_VARIABLE "missing-driver message"]',
  );
  const suite = resolve(args[0]!);
  const driverEnv = args[1] ?? 'PERMISSION_DRIVER_MODULE';
  const message = args[2] ?? 'PERMISSION_DRIVER_MODULE is required: bind a real product permission driver';
  requireThat(
    /^[A-Z_][A-Z0-9_]*$/.test(driverEnv) && message.trim(),
    'Invalid driver variable or empty failure message',
  );
  requireThat(await Bun.file(suite).exists(), `Suite file is missing: ${suite}`);
  const source = await Bun.file(suite).text();
  requireThat(source.trim(), `Suite file is empty: ${suite}`);
  requireThat(
    !/\b(?:test|it|describe)(?:\s*\.\s*\w+)*\s*\.\s*(?:skip|todo|only|skipIf)\b/.test(source),
    'Outcome suites cannot contain skipped, todo, or exclusive scenarios',
  );
  const names = [...source.matchAll(/\b(?:test|it)\s*\(\s*(['"])(.*?)\1\s*,/g)].map((match) => match[2]!);
  requireThat(names.length > 0 && new Set(names).size === names.length, 'Expected unique literal scenario names');
  if (driverEnv === 'PERMISSION_DRIVER_MODULE') {
    for (const name of permissionScenarios)
      requireThat(names.includes(name), `Required permission scenario is missing: ${name}`);
  }
  await mkdir('.temp', { recursive: true });
  const temporary = await mkdtemp(resolve('.temp/verify-outcome-'));
  try {
    const report = resolve(temporary, 'red.xml');
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' };
    delete env[driverEnv]; // Ignore even a valid driver inherited from the caller.
    const child = Bun.spawn([process.execPath, 'test', suite, '--reporter=junit', `--reporter-outfile=${report}`], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const deadline = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const expireOrContinue = () => {
      const remainingTimeoutMs = deadline - performance.now();
      if (remainingTimeoutMs <= 0) {
        timedOut = true;
        child.kill();
      } else {
        timer = setTimeout(expireOrContinue, Math.min(remainingTimeoutMs, maximumTimerDelayMs));
      }
    };
    timer = setTimeout(expireOrContinue, Math.min(timeoutMs, maximumTimerDelayMs));
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));
    const output = `${stdout}\n${stderr}`;
    requireThat(!timedOut, `Missing-driver run timed out after ${timeoutMs} ms (VERIFY_OUTCOME_TIMEOUT_MS)`);
    requireThat(code !== 0, 'Expected a red run without a driver, but Bun passed');
    requireThat(output.includes(`error: ${message}`), `Expected clear missing-driver failure was absent:\n${output}`);
    requireThat(
      !/^\s*[1-9]\d* errors?\b/m.test(output) &&
        [...output.matchAll(/^error: (.*)$/gm)].every((match) => match[1] === message),
      `Unexpected syntax, import, or runtime failure:\n${output}`,
    );
    requireThat(await Bun.file(report).exists(), `Bun did not produce a scenario report:\n${output}`);
    const junit = await Bun.file(report).text();
    const cases = [...junit.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
    requireThat(
      cases.length === names.length && !/<(?:skipped|error)\b/.test(junit),
      'Not every declared scenario executed',
    );
    for (const name of names) {
      const matches = cases.filter((entry) => entry[1]!.includes(`name="${xml(name)}"`));
      requireThat(
        matches.length === 1 && matches[0]![2]?.includes(`<failure type="Error" message="${xml(message)}"`),
        `Scenario did not fail clearly for the missing driver: ${name}`,
      );
    }
    console.log(`RED RUN: ${suite}\n${driverEnv} unset; Bun exited ${code}.`);
    console.log(
      `error: ${message}\n${cases.length} scenarios failed for the expected missing driver; zero skips/todos.`,
    );
    console.log(
      'Specification verifier PASS. Product acceptance remains RED until the suite passes with a real driver.',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  await verify().catch((error) => {
    console.error(`Specification verifier FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

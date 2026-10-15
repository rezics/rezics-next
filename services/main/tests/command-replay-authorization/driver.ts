import { expect, test } from 'bun:test';
import { withBrokerAdmission } from './backpressure.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorityLosses, buildReplayScenario, capabilityReplayEntry, resourceIdentityReplayEntry,
  type AuthorityLoss, type NonReplayEntry, type AnyReplayEntry } from './authority-classes.ts';

function originalResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const { replayed: _replayed, ...rest } = result as Record<string, unknown>;
  return rest;
}
async function refusal(command: () => Promise<unknown>): Promise<{ disclosed?: unknown; error?: unknown }> {
  try { return { disclosed: await command() }; }
  catch (error) { return { error }; }
}

export const replayCaseNames = (entry: AnyReplayEntry, subcase: string, loss: AuthorityLoss) => [
  `${entry.family} / ${subcase} / ${loss}: original, binding, fresh refusal and preservation controls`,
  `${entry.family} / ${subcase} / ${loss}: exact replay requires current authority`,
];

// Kept separate so an area's registered red witness never excuses failed controls.
export async function replayControls(row: AnyReplayEntry, subcase: string, loss: AuthorityLoss) {
  validateReplayEntry(row);
  const prepared = await withBrokerAdmission(() => buildReplayScenario(row, subcase, loss));
  const fixture = { ...prepared, command: (fresh?: boolean, changed?: boolean) =>
    withBrokerAdmission(() => prepared.command(fresh, changed)) };
  const identity = (result: unknown) => row.resultIdentity ? row.resultIdentity(result) : originalResult(result);
  const original = await fixture.command();
  expect(original).toBeTruthy();
  const saved = resourceIdentityReplayEntry(row) ? await fixture.snapshot() : undefined;
  expect(identity(await fixture.command())).toEqual(identity(original));
  if (resourceIdentityReplayEntry(row)) {
    expect(await fixture.snapshot()).toEqual(saved);
    expect(row.resourceIdentity.trim().length).toBeGreaterThan(0);
    expect(identity(await fixture.command(true))).toEqual(identity(original));
    expect(await fixture.snapshot()).toEqual(saved);
    const changed = await refusal(() => fixture.command(false, true));
    if (row.changedBody === 'saved-result') {
      expect(changed.error).toBeUndefined();
      expect(identity(changed.disclosed)).toEqual(identity(original));
    } else if ('refusal' in row.changedBody) expect(changed.error).toBeInstanceOf(row.changedBody.refusal);
    else {
      expect(changed.error).toBeUndefined();
      expect(identity(changed.disclosed)).toEqual(row.changedBody.result);
    }
  } else expect((await refusal(() => fixture.command(false, true))).error).toBeInstanceOf(row.conflict);
  if (fixture.advance) await withBrokerAdmission(fixture.advance);
  expect(identity(await fixture.command())).toEqual(identity(original));
  if (row.authorityClass === 'resource-identity') {
    expect(identity(await fixture.command(true))).toEqual(identity(original));
  }
  const before = await fixture.snapshot();
  await fixture.lose();
  const replay = await refusal(() => fixture.command());
  const fresh = await refusal(() => fixture.command(true));
  const changed = row.authorityClass === 'controller' || row.authorityClass === 'domain-grant'
    ? row.family === 'Agent profile changes' ? await refusal(() => fixture.command(false, true)) : undefined
    : await refusal(() => fixture.command(false, true));
  const after = await fixture.snapshot();
  expect(after).toEqual(before);
  expect(fresh.error).toBeInstanceOf(row.denials?.[loss] ?? row.denied);
  if (changed) {
    expect(changed.error).toBeInstanceOf(row.denials?.[loss] ?? row.denied);
    expect((changed.error as Error).message).toBe((fresh.error as Error).message);
  }
  if (fixture.restore) {
    await fixture.restore();
    expect(identity(await fixture.command())).toEqual(identity(original));
    expect(await fixture.snapshot()).toEqual(before);
  }
  return { family: row.family, authorityClass: row.authorityClass,
    resourceIdentity: resourceIdentityReplayEntry(row) ? row.resourceIdentity : undefined,
    subcase, loss, original, replay, fresh, before, after };
}

export function assertCurrentAuthority(row: AnyReplayEntry, proof: Awaited<ReturnType<typeof replayControls>>) {
  expect(proof.replay.error, JSON.stringify(proof.replay)).toBeInstanceOf(row.denials?.[proof.loss] ?? row.denied);
  expect((proof.replay.error as Error).message).toBe((proof.fresh.error as Error).message);
}

export function validateReplayEntry(entry: AnyReplayEntry) {
  expect(['controller', 'domain-grant', 'principal', 'capability', 'resource-identity']).toContain(entry.authorityClass);
  expect(entry.subcases.length).toBeGreaterThan(0);
  expect(entry.owners.length).toBeGreaterThan(0);
  expect(entry.scope.trim().length).toBeGreaterThan(0);
  expect(entry.action.trim().length).toBeGreaterThan(0);
  const losses = authorityLosses(entry);
  expect(losses.length).toBeGreaterThan(0);
  expect(new Set(losses).size).toBe(losses.length);
  const allowed: AuthorityLoss[] = entry.authorityClass === 'principal' ? ['expired', 'revoked', 'principal-inactive']
    : capabilityReplayEntry(entry) && entry.singleUse ? ['expired', 'revoked', 'consumed'] : ['expired', 'revoked'];
  for (const loss of losses) expect(allowed).toContain(loss);
  if (entry.authorityClass === 'principal' || entry.authorityClass === 'capability') {
    for (const loss of allowed) expect(losses).toContain(loss);
  }
  if (entry.authorityClass === 'capability') {
    expect(capabilityReplayEntry(entry)).toBe(true);
    if (capabilityReplayEntry(entry)) {
      expect(typeof entry.credential).toBe('function');
      expect(typeof entry.singleUse).toBe('boolean');
    }
  }
  if (entry.authorityClass === 'resource-identity') {
    expect(resourceIdentityReplayEntry(entry)).toBe(true);
    if (resourceIdentityReplayEntry(entry)) expect(entry.resourceIdentity.trim().length).toBeGreaterThan(0);
  }
}

export function registerReplayCases(entries: AnyReplayEntry[],
  evidenceDirectory = join(import.meta.dir, '../../../../.temp/goal/replay-authorization')) {
  for (const row of entries) {
    validateReplayEntry(row);
    for (const subcase of row.subcases) for (const loss of authorityLosses(row)) {
      let proof: Awaited<ReturnType<typeof replayControls>>;
      const names = replayCaseNames(row, subcase, loss);
      test(names[0]!, async () => {
        proof = await replayControls(row, subcase, loss);
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(join(evidenceDirectory, `${row.family.replaceAll(/\W+/g, '-')}-${subcase}-${loss}.json`),
          JSON.stringify(proof, (_key, value: unknown) => value instanceof Error
            ? { name: value.name, message: value.message } : value, 2));
      }, 60_000);
      (row.registration === 'registered-failing' ? test.failing : test)(names[1]!, () => {
        assertCurrentAuthority(row, proof);
      });
    }
  }
}

export async function nonReplayControls(entry: NonReplayEntry, subcase: string) {
  expect(entry.reason.trim().length).toBeGreaterThan(0);
  const fixture = await entry.requestBuilder(subcase);
  await fixture.command();
  const before = await fixture.snapshot();
  expect(await fixture.command()).toEqual(fixture.repeatResult);
  const after = await fixture.snapshot();
  expect(after).toEqual(fixture.afterRepeat);
  // A static label or an unchanged saved receipt cannot prove another execution.
  expect(after).not.toEqual(before);
}

export function registerNonReplayCases(entries: NonReplayEntry[]) {
  for (const entry of entries) {
    expect(entry.subcases.length).toBeGreaterThan(0);
    expect(entry.owners.length).toBeGreaterThan(0);
    for (const subcase of entry.subcases) test(`${entry.family} / ${subcase}: repeat executes without a saved result`,
      () => nonReplayControls(entry, subcase), 60_000);
  }
}

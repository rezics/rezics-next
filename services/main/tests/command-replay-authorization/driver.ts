import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceDirectory, type ReplayEntry } from './fixtures.ts';

function originalResult(result: unknown): unknown {
  const { replayed: _replayed, ...rest } = result as Record<string, unknown>;
  return rest;
}
async function refusal(command: () => Promise<unknown>) {
  try { return { disclosed: await command() }; }
  catch (error) { return { error }; }
}
function registerAuthorityCases(replayFamilies: ReplayEntry[]) {
  for (const row of replayFamilies) for (const subcase of row.subcases) for (const loss of row.losses ?? ['expired', 'revoked'] as const) {
    let observed: Awaited<ReturnType<typeof refusal>>;
    let freshRefusal: Error;
    test(`${row.family} / ${subcase} / ${loss}: original, binding, fresh refusal and preservation controls`, async () => {
      const fixture = await row.requestBuilder(subcase, loss);
      const original = await fixture.command();
      expect(original).toBeTruthy();
      expect(originalResult(await fixture.command())).toEqual(originalResult(original));
      expect((await refusal(() => fixture.command(false, true))).error).toBeInstanceOf(row.conflict);
      await fixture.advance?.();
      expect(originalResult(await fixture.command())).toEqual(originalResult(original));
      const before = await fixture.snapshot();
      await fixture.lose(loss);
      const replay = await refusal(() => fixture.command());
      const fresh = await refusal(() => fixture.command(true));
      const after = await fixture.snapshot();
      writeFileSync(join(evidenceDirectory, `${row.family.replaceAll(/\W+/g, '-')}-${subcase}-${loss}.json`),
        JSON.stringify({ family: row.family, subcase, loss, original, replay, fresh, before, after },
          (_key, value: unknown) => value instanceof Error ? { name: value.name, message: value.message } : value, 2));
      expect(after).toEqual(before);
      expect(fresh.error).toBeInstanceOf(row.denied);
      if (row.family === 'Agent profile changes') {
        const changed = await refusal(() => fixture.command(false, true));
        expect(changed.error).toBeInstanceOf(row.denied);
        expect((changed.error as Error).message).toBe((fresh.error as Error).message);
      }
      observed = replay;
      freshRefusal = fresh.error as Error;
      if (fixture.restore) {
        await fixture.restore();
        expect(originalResult(await fixture.command())).toEqual(originalResult(original));
        expect(await fixture.snapshot()).toEqual(before);
      }
    }, 60_000);
    (row.registration === 'registered-failing' ? test.failing : test)(
      `${row.family} / ${subcase} / ${loss}: exact replay requires current authority`, () => {
        expect(observed.error, JSON.stringify(observed)).toBeInstanceOf(row.denied);
        expect((observed.error as Error).message).toBe(freshRefusal.message);
      });
  }

}

// Controller and domain-grant requests share the disclosure/preservation
// protocol. Entries retain their own actual authority owner and request builder.
export function registerReplayCases(entries: ReplayEntry[]) {
  for (const authorityClass of ['controller', 'domain-grant'] as const) {
    registerAuthorityCases(entries.filter(entry => entry.authorityClass === authorityClass));
  }
}

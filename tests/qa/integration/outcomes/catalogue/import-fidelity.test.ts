import { afterAll, beforeAll, setDefaultTimeout } from 'bun:test';
import declaration from '../../../../../scripts/qa/cases/outcomes/catalogue/import-fidelity.ts';
import { personas } from '../../../../../scripts/qa/cases/outcome-cells.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { assertMusicGrain, assertNativeFacts, assertNativeRelations, assertNativeTags, assertOriginals,
  deniedSourceCommands, openImportFixture, replaySelections, type ImportFixture } from '../../../support/import-outcomes.ts';

setDefaultTimeout(180_000);
let fixture: ImportFixture;
beforeAll(async () => { fixture = await openImportFixture(declaration); }, 600_000);
afterAll(async () => { await fixture?.close(); });

// Pending is intentional: the runner's expected-failure behavior records no proof.
// A setup failure never establishes an outcome failure on the pinned baseline.
for (const persona of personas) outcomeTest(declaration, persona, async () => {
  const person = fixture.people[persona];
  await assertOriginals(person, fixture);
  await assertNativeFacts(person, fixture);
  await assertNativeRelations(person, fixture);
  await assertNativeTags(person, fixture);
  await assertMusicGrain(person, fixture);
  await deniedSourceCommands(persona, fixture);
  if (persona === 'operator') await replaySelections(fixture);
});

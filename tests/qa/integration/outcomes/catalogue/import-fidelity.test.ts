import { afterAll, beforeAll, setDefaultTimeout } from 'bun:test';
import declaration from '../../../../../scripts/qa/cases/outcomes/catalogue/import-fidelity.ts';
import type { Persona } from '../../../../../scripts/qa/cases/outcome-cells.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { assertMusicGrain, assertNativeFacts, assertNativeRelations, assertNativeTags, assertOriginals,
  assertRetainedRecordAdmissions, deniedSourceCommands, openImportFixture, replaySelections,
  type ImportFixture } from '../../../support/import-outcomes.ts';

setDefaultTimeout(180_000);
let fixture: ImportFixture;
beforeAll(async () => { fixture = await openImportFixture(declaration); }, 600_000);
afterAll(async () => { await fixture?.close(); });

// Pending is declaration state; genuine baseline failures are not inverted.
// A setup failure never establishes an outcome failure on the pinned baseline.
async function importFidelity(persona: Persona): Promise<void> {
  const person = fixture.people[persona];
  await assertOriginals(person, fixture);
  await assertNativeFacts(person, fixture);
  await assertNativeRelations(person, fixture);
  await assertNativeTags(person, fixture);
  await assertMusicGrain(person, fixture);
  await deniedSourceCommands(persona, fixture);
  if (persona === 'operator') {
    await replaySelections(fixture);
    await assertRetainedRecordAdmissions(fixture);
  }
}

outcomeTest(declaration, 'visitor', () => importFidelity('visitor'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'stranger', () => importFidelity('stranger'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'member', () => importFidelity('member'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'owner', () => importFidelity('owner'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'moderator', () => importFidelity('moderator'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'operator', () => importFidelity('operator'), undefined, { pending: 'assert' });

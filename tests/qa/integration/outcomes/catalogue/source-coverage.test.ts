import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import declaration from '../../../../../scripts/qa/cases/outcomes/catalogue/source-coverage.ts';
import type { Persona } from '../../../../../scripts/qa/cases/outcome-cells.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { assertAtomicRefresh, assertCoverageStates, assertIndependentWithdrawal, assertInventory,
  assertHumanSupportWithdrawal, assertNativeFacts, assertRetainedRecordAdmissions, confirmHumanValue,
  coverage, deniedSourceCommands, matrix, openImportFixture,
  type ImportFixture } from '../../../support/import-outcomes.ts';

setDefaultTimeout(180_000);
let fixture: ImportFixture;
beforeAll(async () => { fixture = await openImportFixture(declaration); }, 600_000);
afterAll(async () => { await fixture?.close(); });

async function sourceCoverage(persona: Persona): Promise<void> {
  const person = fixture.people[persona];
  await assertCoverageStates(person, fixture);
  await assertNativeFacts(person, fixture);
  for (const sourceKey of ['vndb:vn:v11', 'bangumi:subject:1014', matrix.music.album]) {
    const actual = await coverage(person, fixture, sourceKey);
    const anonymous = await coverage(fixture.people.visitor, fixture, sourceKey);
    expect(actual.items, 'sign-in, membership, moderation and operator roles do not widen the public source read')
      .toEqual(anonymous.items);
  }
  await deniedSourceCommands(persona, fixture);
  if (persona === 'owner') await confirmHumanValue(fixture);
  if (persona === 'operator') {
    await assertRetainedRecordAdmissions(fixture);
    await assertInventory(fixture);
    await confirmHumanValue(fixture);
    await assertIndependentWithdrawal(fixture);
    await assertHumanSupportWithdrawal(fixture);
    await assertAtomicRefresh(fixture);
  }
}

outcomeTest(declaration, 'visitor', () => sourceCoverage('visitor'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'stranger', () => sourceCoverage('stranger'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'member', () => sourceCoverage('member'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'owner', () => sourceCoverage('owner'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'moderator', () => sourceCoverage('moderator'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'operator', () => sourceCoverage('operator'), undefined, { pending: 'assert' });

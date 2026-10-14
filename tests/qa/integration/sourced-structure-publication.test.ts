import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { originalRecipe, type RecipeWork }
  from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let recipe: RecipeWork;

beforeAll(async () => {
  sessions = await personaSessions('public');
  recipe = await originalRecipe(sessions.owner, 'Sourced publication authority boundary');
});
afterAll(async () => { await sessions?.close(); });

// A syntactically valid sourced request must reach the existing identity and
// Access boundary before attempting to resolve its private Source evidence.
for (const [persona, status] of [['visitor', 401], ['stranger', 403]] as const) {
  test(`sourced structured publication preserves the ${persona} refusal`, async () => {
    const response = await sessions[persona].main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish',
      work: recipe.work, actingSubject: sessions[persona].actingSubject ?? sessions.owner.actingSubject,
      expectedWorkHead: recipe.workRevision, expectedMainVersion: recipe.mainVersion,
      structure: recipe.structure, expectedStructureHead: recipe.revision,
      expectedPublicationHead: null, disclosure: 'public', rightsBasis: 'public-domain',
      sourceObservation: `https://rezics.com/id/${randomUUID()}`,
    });
    const body = await response.text();
    expect(response.status, body).toBe(status);
  });
}

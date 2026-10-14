import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { acting, originalRecipe, short, type RecipeWork } from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';
import { comparableBody } from '../support/hidden-id-equality.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions, privateRecipe: RecipeWork, published: RecipeWork;
beforeAll(async () => {
  sessions = await personaSessions('public');
  privateRecipe = await originalRecipe(sessions.owner, 'Private exact export', { published: false });
  published = await originalRecipe(sessions.owner, 'Published exact export', { laterDraft: true });
}, 240_000);
afterAll(async () => { await sessions?.close(); });

test('native and Schema.org exports conceal hidden Structures and draft revisions exactly like missing ones', async () => {
  if (!published.draftRevision) throw new Error('fixture requires a private successor');
  for (const format of ['native', 'schema-org']) {
    const path = (structure: string, revision?: string) => `/v1/recipes/${structure}/export?${new URLSearchParams({
      ...acting(sessions.stranger), format, ...(revision ? { revision } : {}),
    })}`;
    const hidden = await sessions.stranger.main('GET', path(short(privateRecipe.structure)));
    const missing = await sessions.stranger.main('GET', path(randomUUID()));
    expect(hidden.status).toBe(404); expect(missing.status).toBe(404);
    expect(comparableBody(await hidden.text())).toBe(comparableBody(await missing.text()));
    const draft = await sessions.stranger.main('GET', path(short(published.structure), published.draftRevision));
    const absent = await sessions.stranger.main('GET', path(short(published.structure), `https://rezics.com/id/${randomUUID()}`));
    expect(draft.status).toBe(404); expect(absent.status).toBe(404);
    expect(comparableBody(await draft.text())).toBe(comparableBody(await absent.text()));
    const owner = await sessions.owner.main('GET', `/v1/recipes/${short(privateRecipe.structure)}/export?${new URLSearchParams({
      ...acting(sessions.owner), format,
    })}`);
    expect(owner.status).toBe(200);
    for (const id of [short(privateRecipe.structure), randomUUID()]) {
      expect((await sessions.visitor.main('GET', `/v1/recipes/${id}/export?format=${format}`)).status).toBe(401);
    }
  }
});

test('a zero serving denominator is refused before creating a measure revision', async () => {
  const owner = sessions.owner;
  const response = await owner.main('POST', `/v1/recipes/${short(privateRecipe.structure)}/measures`, {
    expectedHead: privateRecipe.revision, actingSubject: owner.actingSubject,
    yield: { value: { numerator: 1, denominator: 1 }, unitText: 'servings', coverage: 'complete', provenance: 'declared' },
    servings: { value: { numerator: 0, denominator: 1 }, coverage: 'complete', provenance: 'declared' },
  });
  expect(response.status).toBe(400);
  const current = await owner.main('GET', `/v1/recipes/${short(privateRecipe.structure)}/export?${new URLSearchParams({
    ...acting(owner), format: 'native',
  })}`);
  expect(current.status).toBe(200);
  expect((await current.json() as { revision: string }).revision).toBe(privateRecipe.revision);
});

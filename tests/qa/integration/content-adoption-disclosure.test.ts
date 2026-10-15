import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { personaSessions, type PersonaSession } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { originalRecipe, short, fixtureAnswer as answer } from '../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { document, paragraph, type BlocksDocument } from '../../../scripts/qa/cases/outcomes/recipes/instructions-in-any-form.ts';

const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
async function post(person: PersonaSession, value: BlocksDocument) {
  const actingSubject = person.actingSubject;
  const book = await answer<{ work: string; mainVersion: string }>(person.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Private instruction notebook', language: 'en',
    semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject,
  }), 201);
  const composition = await answer<{ structure: string; revision: string }>(person.main('POST', '/v1/compositions', {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject,
  }), 201);
  const created = await answer<{ post: string; variantId: string }>(person.main('POST', `/v1/works/${short(book.work)}/chapters`, {
    profile: 'book-chapter-create-v1', title: 'Private method', language: 'en', direction: 'ltr',
    parent: composition.structure, position: 'last', expectedCompositionHead: composition.revision, actingSubject,
  }));
  const draft = await answer<{ revisionId: string }>(person.main('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: created.post, variantId: created.variantId,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    expectedHead: null, document: value, actingSubject,
  }), 201);
  return { ...created, ...draft };
}
const reference = (value: Awaited<ReturnType<typeof post>>, block?: string) => ({ target: value.post,
  selector: { grain: 'content' as const, variantId: value.variantId, revision: value.revisionId, ...(block ? { block } : {}) } });
async function adopt(person: PersonaSession, selected: ReturnType<typeof reference>) {
  const recipe = await originalRecipe(person, 'Exact private instruction adoption', { published: false });
  const changed = await answer<{ revision: string }>(person.main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: recipe.revision, actingSubject: person.actingSubject,
    operations: [{ op: 'insert', role: 'instruction', parent: recipe.structure, position: 'last', target: selected.target,
      selection: { mode: 'fixed-revision', revision: selected.selector.revision, selector: selected.selector } }],
  }));
  return { ...recipe, revision: changed.revision };
}

test('an anonymous reader gets only the adopted procedure on the Recipe, export and reference APIs', async () => {
  const sessions = await personaSessions('public');
  try {
    const owner = sessions.owner, visitor = sessions.visitor;
    const source = await post(owner, document([paragraph('journal', 'PRIVATE journal beside the procedure'),
      { type: 'extensionBlock', attrs: { id: 'procedure', definition: 'https://rezics.com/definition/procedure-v1',
        version: '1', fallback: 'Stir.', payload: { items: [{ id: 'stir', type: 'HowToStep',
          document: document([paragraph('step', 'Stir.')]) }] } } }]));
    const selected = reference(source, 'procedure'), recipe = await adopt(owner, selected);
    await answer(owner.main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
      expectedWorkHead: recipe.workRevision, expectedMainVersion: recipe.mainVersion,
      structure: recipe.structure, expectedStructureHead: recipe.revision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
    }), 201);
    for (const path of [`/v1/recipes/works/${short(recipe.work)}`,
      `/v1/recipes/${short(recipe.structure)}/export?format=native&revision=${encodeURIComponent(recipe.revision)}`]) {
      const body = await answer(visitor.main('GET', path));
      expect(JSON.stringify(body)).toContain('Stir.');
      expect(JSON.stringify(body)).not.toContain('PRIVATE journal');
    }
    const resolved = await answer<{ items: { status: string; document?: unknown }[] }>(visitor.main('POST',
      '/v1/resource-reference-resolutions', { references: [selected, reference(source), reference(source, 'journal')] }));
    expect(resolved.items.map(item => item.status)).toEqual(['available', 'unavailable', 'unavailable']);
    expect(JSON.stringify(resolved)).not.toContain('PRIVATE journal');
    expect((await visitor.main('GET', `/v1/content-revisions/${source.revisionId}`)).status).toBe(404);
    expect((await owner.main('GET', `/v1/content-revisions/${source.revisionId}?${query(owner)}`)).status).toBe(200);
  } finally { await sessions.close(); }
}, 240_000);

test('a private Recipe reader loses Post bytes on preview and native export when Post read authority is revoked', async () => {
  const sessions = await personaSessions('public');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const reader = sessions.stranger;
    const source = await post(sessions.owner, document([paragraph('method', 'PRIVATE revoked method')]));
    const scope = `work:read:${source.post}`;
    await grantPersonaFixtureAuthority(reader, [{ scope, action: 'work.read' }]);
    const recipe = await adopt(reader, reference(source));
    const paths = [`/v1/recipes/works/${short(recipe.work)}?${query(reader)}&revision=${encodeURIComponent(recipe.revision)}`,
      `/v1/recipes/${short(recipe.structure)}/export?${query(reader)}&format=native&revision=${encodeURIComponent(recipe.revision)}`];
    for (const path of paths) expect(JSON.stringify(await answer(reader.main('GET', path)))).toContain('PRIVATE revoked method');
    // Revoke this target alone; the principal and Recipe preview remain live.
    await pool.query('UPDATE access.permission_grant SET active = false WHERE scope_id = $1 AND recipient_subject = $2',
      [scope, reader.actingSubject]);
    expect((await reader.main('GET', `/v1/content-revisions/${source.revisionId}?${query(reader)}`)).status).toBe(404);
    for (const path of paths) {
      const body = await answer(reader.main('GET', path));
      expect(JSON.stringify(body)).not.toContain('PRIVATE revoked method');
    }
    const page = await answer<{ instructions: { status: string }[] }>(reader.main('GET', paths[0]!));
    expect(page.instructions.map(item => item.status)).toEqual(['unavailable']);
  } finally { await pool.end(); await sessions.close(); }
}, 240_000);

test('a reference response rechecks private Post authority after waiting on another owner', async () => {
  const sessions = await personaSessions('public');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const held = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    const owner = sessions.owner, reader = sessions.stranger;
    const first = await post(owner, document([paragraph('first', 'PRIVATE in-flight method')]));
    const second = await post(owner, document([paragraph('second', 'Second method')]));
    const firstScope = `work:read:${first.post}`, secondScope = `work:read:${second.post}`;
    await grantPersonaFixtureAuthority(reader, [firstScope, secondScope].map(scope => ({ scope, action: 'work.read' })));
    await held.query('BEGIN');
    await held.query('SELECT id FROM access.scope_gate WHERE id = $1 FOR UPDATE', [secondScope]);
    const pid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    pending = reader.main('POST', '/v1/resource-reference-resolutions', {
      references: [reference(first), reference(second)], actingSubject: reader.actingSubject,
    });
    // Wait for the real second Access read, rather than guessing when the first resolved.
    const deadline = Date.now() + 1500;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      blocked = (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0;
      if (!blocked) await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE scope_id = $1 AND recipient_subject = $2',
      [firstScope, reader.actingSubject]);
    await held.query('COMMIT');
    const result = await answer<{ items: { status: string }[] }>(pending);
    expect(result.items.map(item => item.status)).toEqual(['unavailable', 'available']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE in-flight method');
  } finally {
    await held.query('ROLLBACK'); held.release();
    await pending?.catch(() => undefined);
    await pool.end(); await sessions.close();
  }
}, 240_000);

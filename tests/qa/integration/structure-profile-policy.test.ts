import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';
import { seekOccurrence } from '../../../services/main/src/modules/structure/reading-order.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('profile navigation keeps immutable anchors across withheld entries in both directions', async () => {
  const stack = await startMediaStack('profile-reading-policy');
  try {
    const editor = await stack.member('profile-reader');
    const owner = await stack.catalogueWork(editor.actor, 'Section reading anchors');
    await editor.grant(`work:edit:${owner.work}`, 'work.edit');
    const targets = await Promise.all(['First', 'Hidden', 'Last'].map(title => stack.catalogueWork(editor.actor, title)));
    const created = await json<{ structure: string; revision: string }>(await editor.send('POST', '/v1/compositions', {
      profile: 'section-list-v1', work: owner.work, mainVersion: owner.mainVersion, actingSubject: editor.actor,
    }), 201);
    // Each target must be readable when it is attached; navigation makes a fresh decision.
    for (const target of targets) await editor.grant(`work:read:${target.work}`, 'work.read');
    const changed = await json<{ occurrences: string[] }>(await editor.send('POST', `/v1/compositions/${short(created.structure)}/changes`, {
      profile: 'section-list-v1', expectedHead: created.revision, actingSubject: editor.actor,
      operations: targets.map(target => ({ op: 'insert', role: 'entry', parent: created.structure,
        position: 'last', target: target.work, qualifier: { note: target.title } })),
    }));
    const canReadTarget = async (target: string) => target !== targets[1]!.work;
    const first = await seekOccurrence(stack.env, { structure: created.structure, canReadTarget });
    expect(first?.record.occurrence).toBe(changed.occurrences[0]!);
    const next = await seekOccurrence(stack.env, { structure: created.structure, from: first!.record, canReadTarget });
    expect(next?.record.occurrence).toBe(changed.occurrences[2]!);
    const previous = await seekOccurrence(stack.env, { structure: created.structure, from: next!.record,
      direction: 'previous', canReadTarget });
    expect(previous?.record.occurrence).toBe(first!.record.occurrence);
    expect(await seekOccurrence(stack.env, { structure: created.structure, from: next!.record, canReadTarget })).toBeNull();
  } finally { await stack.stop(); }
}, 120_000);

test('Recipe profile validates relations and fences owner type removal against attachment', async () => {
  const stack = await startMediaStack('profile-write-policy');
  try {
    const editor = await stack.member('profile-writer');
    const owner = await stack.catalogueWork(editor.actor, 'Recipe profile relations', ['https://schema.org/Recipe']);
    await editor.grant(`work:edit:${owner.work}`, 'work.edit');
    await editor.grant(`work:edit:${owner.work}`, 'recipe.edit');
    const create = () => editor.send('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: owner.work, mainVersion: owner.mainVersion, actingSubject: editor.actor,
    });
    const created = await json<{ structure: string; revision: string }>(await create(), 201);
    const invalid = await editor.send('POST', `/v1/compositions/${short(created.structure)}/changes`, {
      profile: 'recipe-composition', expectedHead: created.revision, actingSubject: editor.actor,
      operations: [{ op: 'insert', role: 'ingredient', parent: created.structure, position: 'last', qualifier: {
        type: 'ingredient-line', originalText: { value: 'flour', language: 'en' }, optional: false,
        scaling: 'linear', substituteFor: [], parseStatus: 'partial', amountUpper: { numerator: 2, denominator: 1 },
      } }],
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('lower bound');

    const racing = await stack.catalogueWork(editor.actor, 'Recipe attachment race', ['https://schema.org/Recipe']);
    await editor.grant(`work:edit:${racing.work}`, 'work.edit');
    await editor.grant(`work:edit:${racing.work}`, 'recipe.edit');
    const current = await stack.env.fuseki.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(racing.work)} <https://rezics.com/vocab/head> ?head } }`);
    const [attachment, removal] = await Promise.all([
      editor.send('POST', '/v1/compositions', { profile: 'recipe-composition', work: racing.work,
        mainVersion: racing.mainVersion, actingSubject: editor.actor }),
      editor.send('PUT', `/v1/works/${short(racing.work)}/type`, { profile: 'work-type-v3',
        expectedHead: current.results!.bindings[0]!.head!.value, types: [], actingSubject: editor.actor }),
    ]);
    expect([attachment.status, removal.status]).not.toEqual([201, 200]);
    expect(attachment.status === 201 || removal.status === 200).toBe(true);
    const state = await stack.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ?structure <https://rezics.com/vocab/structureOf> ${iri(racing.mainVersion)} .
      FILTER NOT EXISTS { ${iri(racing.work)} a <https://schema.org/Recipe> }
    } }`);
    expect(state.boolean).toBe(false);
  } finally { await stack.stop(); }
}, 120_000);

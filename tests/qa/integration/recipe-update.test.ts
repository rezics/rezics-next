import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

type Qualifier = NonNullable<OccurrenceRecord['qualifier']>;
type IngredientQualifier = Extract<Qualifier, { type: 'ingredient-line' }>;
type StepQualifier = Extract<Qualifier, { type: 'recipe-step' }>;
type Change = { structure: string; revision: string; receipt: string; replayed: boolean;
  occurrences: string[]; cost: { pagesRead: number; pagesWritten: number;
    placementsWritten: number; segmentsWritten: number; rebalanced: number } };
type Page = { revision: string; occurrences: OccurrenceRecord[] };

const ingredient = (text: string, substituteFor: string[] = []): IngredientQualifier => ({
  type: 'ingredient-line', originalText: { value: text, language: 'en' },
  amount: { numerator: 1, denominator: 2 }, amountLexical: '1/2 cup',
  unitText: 'cup', optional: false, scaling: 'linear', substituteFor, parseStatus: 'partial',
});
const step = (text: string, usesIngredient: string[]): StepQualifier => ({
  type: 'recipe-step', instructionText: { value: text, language: 'en' },
  usesIngredient, media: [], scaling: 'linear',
});

test('Recipe qualifier edits retain occurrences and refuse invalid local ingredient references', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-update-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  const create = async (title: string) => {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST',
      '/v1/works', await f.authoredBody({ profile: 'metadata-only-v1', title, language: 'en',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    return f.json<Change>(await f.call('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
      actingSubject: f.actor,
    }), 201);
  };
  const path = (composition: Pick<Change, 'structure'>) =>
    `/v1/compositions/${shortId(composition.structure)}`;
  const body = (composition: Pick<Change, 'revision'>, operations: object[]) => ({
    profile: 'recipe-composition', expectedHead: composition.revision,
    actingSubject: f.actor, operations,
  });
  const change = (composition: Pick<Change, 'structure' | 'revision'>, operations: object[],
    key = randomUUID(), token = f.account.tokenA) =>
    f.call('POST', `${path(composition)}/changes`, body(composition, operations), key, token);
  const read = async (composition: Pick<Change, 'structure'>, revision?: string) => f.json<Page>(
    await f.call('GET', `${path(composition)}`
      + (revision ? `/revisions/${shortId(revision)}` : '')
      + `?actingSubject=${encodeURIComponent(f.actor)}`), 200);
  const insert = (composition: Pick<Change, 'structure'>, role: 'ingredient' | 'step',
    qualifier: Qualifier, sourceKey: string) => ({ op: 'insert', parent: composition.structure,
    position: 'last', role, qualifier, sourceKey });
  const update = (occurrence: string, qualifier: Qualifier) => ({ op: 'update', occurrence, qualifier });
  try {
    const created = await create('Stable recipe qualifier edits');
    const originalFlour = ingredient('1/2 cup flour');
    const lines = await f.json<Change>(await change(created, [
      insert(created, 'ingredient', originalFlour, 'flour'),
      insert(created, 'ingredient', ingredient('1/2 cup rice flour'), 'rice-flour'),
    ]), 200);
    const [flour, substitute] = lines.occurrences as [string, string];
    const originalStep = step('Stir the flour.', [flour]);
    const withStep = await f.json<Change>(await change(lines, [
      insert(created, 'step', originalStep, 'stir'),
    ]), 200);
    const instruction = withStep.occurrences[0]!;
    const before = await read(created);
    const projectedOrder = async () => (await f.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT ?placement ?occurrence ?position WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.structure)} rv:selectedGeneration ?generation .
        ?placement rv:generation ?generation ; rv:occurrence ?occurrence ; schema:position ?position .
      } } ORDER BY ?placement`)).results?.bindings ?? [];
    const placements = await projectedOrder();
    expect(placements).toHaveLength(3);

    const editedFlour: IngredientQualifier = { ...originalFlour,
      originalText: { value: '250 g sifted flour', language: 'en' },
      amount: { numerator: 250, denominator: 1 }, amountLexical: '250 g',
      unit: 'https://qudt.org/vocab/unit/GM', unitText: 'g',
      preparation: { value: 'sift before measuring', language: 'en' }, parseStatus: 'parsed' };
    const editedStep = step('Fold in the sifted flour gently.', [flour]);
    const edits = [update(flour, editedFlour), update(instruction, editedStep)];
    expect((await change(withStep, edits, randomUUID(), f.account.noScope)).status).toBe(401);
    expect((await change(withStep, edits, randomUUID(), f.account.tokenB)).status).toBe(403);
    const key = randomUUID();
    const edited = await f.json<Change>(await change(withStep, edits, key), 200);
    expect(edited.cost).toMatchObject({ placementsWritten: 2, segmentsWritten: 0, rebalanced: 0 });
    expect(edited.occurrences).toEqual([]);
    expect(await f.json<Change>(await change(withStep, edits, key), 200)).toMatchObject({
      revision: edited.revision, receipt: edited.receipt, replayed: true,
    });
    expect((await change(withStep, edits, key, f.account.tokenB)).status).toBe(403);
    expect((await change(withStep, [update(instruction, step('Different retry', [flour]))], key)).status)
      .toBe(409);
    expect((await change(withStep, edits)).status).toBe(409);
    const after = await read(created);
    expect(after.occurrences.map(record => record.occurrence)).toEqual(before.occurrences.map(record => record.occurrence));
    for (const previous of before.occurrences) {
      const current = after.occurrences.find(record => record.occurrence === previous.occurrence)!;
      expect({ ...current, qualifier: previous.qualifier }).toEqual(previous);
    }
    expect(after.occurrences.find(record => record.occurrence === flour)?.qualifier).toMatchObject({
      ...editedFlour, amount: { numerator: 250, denominator: 1 },
    });
    expect(after.occurrences.find(record => record.occurrence === instruction)?.qualifier).toEqual(editedStep);
    expect(await projectedOrder()).toEqual(placements);
    expect((await read(created, withStep.revision)).occurrences).toEqual(before.occurrences);

    const dangling = nativeId();
    // Role changes are not qualifier edits. They must cancel without rewriting the occurrence.
    for (const operation of [update(flour, editedStep), update(instruction, editedFlour)]) {
      expect((await change(edited, [operation])).status).toBe(409);
    }
    expect((await change(edited, [
      update(flour, ingredient('Valid ingredient edit in rejected batch')),
      update(instruction, step('Dangling reference in rejected batch', [dangling])),
    ])).status).toBe(409);
    expect((await read(created)).revision).toBe(edited.revision);
    expect((await read(created)).occurrences).toEqual(after.occurrences);
    const other = await create('Independent ingredient owner');
    const foreign = await f.json<Change>(await change(other, [
      insert(other, 'ingredient', ingredient('Foreign flour'), 'foreign-flour'),
    ]), 200);
    for (const invalidReference of [foreign.occurrences[0]!, dangling, instruction]) {
      for (const operation of [
        update(instruction, step('Invalid step reference', [invalidReference])),
        update(substitute, ingredient('Invalid substitution', [invalidReference])),
        insert(created, 'step', step('Invalid inserted reference', [invalidReference]), 'invalid-step'),
        insert(created, 'ingredient', ingredient('Invalid inserted substitution', [invalidReference]), 'invalid-line'),
      ]) expect((await change(edited, [operation])).status).toBe(409);
    }
    expect((await read(created)).revision).toBe(edited.revision);

    // Both qualifiers see the same final candidate, while the single-kind batch bound remains in force.
    let current = await f.json<Change>(await change(edited, [
      update(substitute, ingredient('Rice flour instead of wheat flour', [flour])),
      update(instruction, step('Choose either flour.', [flour, substitute])),
    ]), 200);
    expect((await read(created)).occurrences.find(record => record.occurrence === substitute)?.qualifier)
      .toMatchObject({ substituteFor: [flour] });
    // The immutable record retains the caller's complete qualifier even when
    // its reference order/repetition projects to the same RDF set.
    current = await f.json<Change>(await change(current, [
      update(instruction, step('Choose either flour.', [substitute, flour, substitute])),
    ]), 200);
    const orderedReferences = (await read(created)).occurrences.find(record => record.occurrence === instruction)!;
    expect(orderedReferences.qualifier).toMatchObject({ usesIngredient: [substitute, flour, substitute] });
    current = await f.json<Change>(await change(current, [{ op: 'update', occurrence: instruction,
      label: { value: 'Mix the dry ingredients', language: 'en' } }]), 200);
    expect((await read(created)).occurrences.find(record => record.occurrence === instruction)?.qualifier)
      .toEqual(orderedReferences.qualifier);
    expect((await change(current, [{ op: 'remove', occurrence: flour }])).status).toBe(409);
    expect((await read(created)).revision).toBe(current.revision);

    const races = await Promise.all(['Whisk first.', 'Stir slowly.'].map(text =>
      change(current, [update(instruction, step(text, [flour, substitute]))])));
    expect(races.map(response => response.status).sort()).toEqual([200, 409]);
    current = await f.json<Change>(races.find(response => response.status === 200)!, 200);
    // Replay remains tied to the accepted historical edit after later heads advance.
    expect(await f.json<Change>(await change(withStep, edits, key), 200)).toMatchObject({
      revision: edited.revision, receipt: edited.receipt, replayed: true,
    });

    // Cross a record leaf boundary with unrelated siblings; an edit still descends only to its IDs.
    const small = await f.json<Change>(await change(current, [
      update(instruction, step('Small composition edit.', [flour, substitute])),
    ]), 200);
    current = small;
    for (let offset = 0; offset < 272; offset += 16) {
      current = await f.json<Change>(await change(current, Array.from({ length: 16 }, (_, index) =>
        insert(created, 'ingredient', ingredient(`Unrelated ingredient ${offset + index}`),
          `unrelated-${offset + index}`))), 200);
    }
    const large = await f.json<Change>(await change(current, [
      update(instruction, step('Large composition edit.', [flour, substitute])),
    ]), 200);
    expect(large.cost).toMatchObject({ placementsWritten: 1, segmentsWritten: 0, rebalanced: 0 });
    expect(large.cost.pagesRead).toBeLessThanOrEqual(small.cost.pagesRead + 8);
    expect(large.cost.pagesWritten).toBeLessThanOrEqual(small.cost.pagesWritten + 2);

    // The bounded removal probe must stop at one surviving incoming reference.
    const queries: string[] = [];
    const query = f.nativeFuseki.query.bind(f.nativeFuseki);
    f.nativeFuseki.query = async (sparql, maxBytes) => {
      queries.push(sparql);
      return query(sparql, maxBytes);
    };
    try {
      expect((await change(large, [{ op: 'remove', occurrence: flour }])).status).toBe(409);
    } finally { f.nativeFuseki.query = query; }
    const incoming = queries.filter(sparql => sparql.includes('usesIngredient') || sparql.includes('substituteFor'));
    expect(incoming.length).toBeGreaterThan(0);
    for (const sparql of incoming) {
      expect(sparql).toContain('VALUES');
      expect(sparql).toContain(iri(flour));
      expect(sparql).toMatch(/LIMIT\s+1\b/u);
    }
    // Removing every affected sibling in one batch leaves no active dangling reference.
    const removed = await f.json<Change>(await change(large, [
      { op: 'remove', occurrence: flour },
      { op: 'remove', occurrence: substitute },
      { op: 'remove', occurrence: instruction },
    ]), 200);
    for (const operation of [
      insert(created, 'step', step('Removed ingredient', [flour]), 'removed-step'),
      insert(created, 'ingredient', ingredient('Removed substitution', [substitute]), 'removed-line'),
    ]) expect((await change(removed, [operation])).status).toBe(409);
    expect((await read(created)).revision).toBe(removed.revision);
    expect((await read(created, withStep.revision)).occurrences).toEqual(before.occurrences);
  } finally { await f.close(); }
}, 240_000);

test('Recipe atomic reference edits overlay each removed ingredient without changing surviving identities', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-reference-overlay-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  const path = (composition: Pick<Change, 'structure'>) =>
    `/v1/compositions/${shortId(composition.structure)}`;
  const change = (composition: Pick<Change, 'structure' | 'revision'>, operations: object[],
    key = randomUUID()) => f.call('POST', `${path(composition)}/changes`, {
      profile: 'recipe-composition', expectedHead: composition.revision,
      actingSubject: f.actor, operations,
    }, key);
  const read = async (composition: Pick<Change, 'structure'>, revision?: string) => f.json<Page>(
    await f.call('GET', `${path(composition)}`
      + (revision ? `/revisions/${shortId(revision)}` : '')
      + `?actingSubject=${encodeURIComponent(f.actor)}`), 200);
  const update = (occurrence: string, qualifier: Qualifier) => ({ op: 'update', occurrence, qualifier });
  const remove = (occurrence: string) => ({ op: 'remove', occurrence });
  const seed = async (role: 'step' | 'ingredient') => {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST',
      '/v1/works', await f.authoredBody({ profile: 'metadata-only-v1',
        title: `Atomic recipe ${role} reference edit`, language: 'en',
        semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<Change>(await f.call('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
      actingSubject: f.actor,
    }), 201);
    const inserted = await f.json<Change>(await change(created, ['A', 'B'].map(sourceKey => ({
      op: 'insert', parent: created.structure, position: 'last', role: 'ingredient',
      qualifier: ingredient(`Ingredient ${sourceKey}`), sourceKey,
    }))), 200);
    const [a, b] = inserted.occurrences as [string, string];
    const current = await f.json<Change>(await change(inserted, [{ op: 'insert',
      parent: created.structure, position: 'last', role,
      qualifier: role === 'step' ? step('Use A and B.', [a, b]) : ingredient('Substitute for A.', [a]),
      sourceKey: 'referrer',
    }]), 200);
    return { current, a, b, referrer: current.occurrences[0]! };
  };
  const boundedChange = async (composition: Pick<Change, 'structure' | 'revision'>,
    operations: object[], removed: string[], key = randomUUID()) => {
    const queries: string[] = [];
    const query = f.nativeFuseki.query.bind(f.nativeFuseki);
    f.nativeFuseki.query = async (sparql, maxBytes) => {
      queries.push(sparql);
      return query(sparql, maxBytes);
    };
    let response: Response;
    try { response = await change(composition, operations, key); }
    finally { f.nativeFuseki.query = query; }
    const incoming = queries.filter(sparql => sparql.includes('SELECT ?referrer'));
    expect(incoming.length).toBeGreaterThan(0);
    expect(incoming.length).toBeLessThanOrEqual(removed.length);
    for (const sparql of incoming) {
      expect(sparql).toMatch(/VALUES\s+\?removed\s*\{\s*<[^>]+>\s*\}/u);
      expect(sparql).toMatch(/LIMIT\s+1\b/u);
      expect(removed.some(id => sparql.includes(iri(id)))).toBe(true);
    }
    return response;
  };
  try {
    for (const role of ['step', 'ingredient'] as const) {
      for (const removeFirst of [false, true]) {
        const { current, a, b, referrer } = await seed(role);
        const before = await read(current);
        const candidate = role === 'step' ? step('Use only B.', [b]) : ingredient('Independent substitute.');
        const operations = [update(referrer, candidate), remove(a)];
        if (removeFirst) operations.reverse();
        const key = randomUUID();
        const accepted = await f.json<Change>(await boundedChange(current, operations, [a], key), 200);
        expect(accepted.occurrences).toEqual([]);
        expect(accepted.cost).toMatchObject({ segmentsWritten: 1, rebalanced: 0 });
        const after = await read(current);
        expect(after.occurrences.map(record => record.occurrence)).toEqual(
          before.occurrences.filter(record => record.occurrence !== a).map(record => record.occurrence));
        for (const record of after.occurrences) {
          const original = before.occurrences.find(previous => previous.occurrence === record.occurrence)!;
          expect({ ...record, qualifier: original.qualifier }).toEqual(original);
        }
        expect(after.occurrences.find(record => record.occurrence === referrer)?.qualifier).toEqual(candidate);
        expect(await f.json<Change>(await change(current, operations, key), 200)).toMatchObject({
          revision: accepted.revision, receipt: accepted.receipt, replayed: true,
        });
        expect((await change(current, operations)).status).toBe(409);
        expect((await change(current, [update(referrer, role === 'step'
          ? step('Changed retry.', [b]) : ingredient('Changed retry.')), remove(a)], key)).status).toBe(409);
        expect((await read(current, current.revision)).occurrences).toEqual(before.occurrences);
        // Replay retains the accepted receipt even once a later head has advanced.
        await f.json<Change>(await change(accepted, [{ op: 'update', occurrence: referrer,
          label: { value: 'Later surviving occurrence edit', language: 'en' } }]), 200);
        expect(await f.json<Change>(await change(current, operations, key), 200)).toMatchObject({
          revision: accepted.revision, receipt: accepted.receipt, replayed: true,
        });
        expect((await read(current, accepted.revision)).occurrences).toEqual(after.occurrences);
      }

      const { current, a, b, referrer } = await seed(role);
      const before = await read(current);
      const remainingReference = role === 'step'
        ? step('Still uses A.', [a]) : ingredient('Still substitutes for A.', [a]);
      // An untouched referrer, an explicit retained reference and a qualifier-omitting
      // label edit all preserve the incoming edge and must roll back the whole batch.
      const candidates: object[][] = [[], [update(referrer, remainingReference)], [{ op: 'update',
        occurrence: referrer, label: { value: 'Qualifier omitted', language: 'en' } }]];
      for (const edits of candidates) {
        for (const removeFirst of [false, true]) {
          const operations = [update(b, ingredient('Must roll back this edit.')), ...edits, remove(a)];
          if (removeFirst) operations.reverse();
          expect((await boundedChange(current, operations, [a])).status).toBe(409);
          expect(await read(current)).toEqual(before);
        }
      }
    }

    const { current, a, b, referrer } = await seed('step');
    const before = await read(current);
    // Exclusion is specific to the removed target: dropping A does not permit
    // removing B while the very same edited step still uses B.
    for (const removeFirst of [false, true]) {
      const operations = [update(referrer, step('Keep B.', [b])), remove(a), remove(b)];
      if (removeFirst) operations.reverse();
      expect((await boundedChange(current, operations, [a, b])).status).toBe(409);
      expect(await read(current)).toEqual(before);
    }
    const accepted = await f.json<Change>(await boundedChange(current, [
      remove(b), update(referrer, step('No ingredients needed.', [])), remove(a),
    ], [a, b]), 200);
    expect((await read(accepted)).occurrences.map(record => record.occurrence)).toEqual([referrer]);
    expect((await read(current, current.revision)).occurrences).toEqual(before.occurrences);
  } finally { await f.close(); }
}, 240_000);

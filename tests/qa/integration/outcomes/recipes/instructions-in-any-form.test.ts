import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import instructions, { document, paragraph, resourceReference,
  type AuthoredPostRequest, type AuthoredPostResponse, type BlocksDocument,
  type ContentDerivationRecord, type ContentDerivationRequest, type ExactContentReference,
  type InstructionPage, type NativeRecipeExport, type ProcedureItem, type ResourceReference,
} from '../../../../../scripts/qa/cases/outcomes/recipes/instructions-in-any-form.ts';
import { acting, originalRecipe, short, type RecipeWork } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { personas } from '../../../../../scripts/qa/cases/outcome-cells.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { grantPersonaFixtureAuthority } from '../../../support/persona-fixture-authority.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(180_000);
let sessions: PersonaSessions;
let recipe: RecipeWork, intermediate: RecipeWork;
let preparation: Promise<Slice> | undefined;
type Stage = { revision: string; references: ResourceReference[]; pages: Record<PersonaName, InstructionPage> };
type Slice = { stages: Stage[]; post: AuthoredPostResponse; procedure: AuthoredPostResponse;
  postDocument: BlocksDocument; procedureDocument: BlocksDocument; derivation: ContentDerivationRecord;
  draftRevision: string; privateContentRevision: string; references: ResourceReference[] };
const privateText = 'PRIVATE successor: use parsley instead.';

async function answer<T>(request: Promise<Response>, status = 200, boundary = 'API'): Promise<T> {
  const response = await request, raw = await response.text();
  if (response.status !== status && boundary.startsWith('Content adoption:')) {
    console.info(`${boundary}; observed HTTP ${response.status}: ${raw}`);
  }
  expect(response.status, `${boundary}: expected HTTP ${status}, got ${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
const query = (person: PersonaSession, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams(acting(person));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `?${params}`;
};
const contentReference = (post: AuthoredPostResponse, block?: string): ExactContentReference => ({
  target: post.post, selector: { grain: 'content', variantId: post.variantId, revision: post.revisionId,
    ...(block ? { block } : {}) },
});
const pagePath = (person: PersonaSession, revision?: string) =>
  `/v1/recipes/works/${short(recipe.work)}${query(person, { servings: '12', ...(revision ? { revision } : {}) })}`;

beforeAll(async () => {
  sessions = await personaSessions('public');
  // Only already implemented operations run in setup. A missing new operation
  // fails all six persona proofs by assertion, rather than failing beforeAll.
  recipe = await originalRecipe(sessions.owner, 'Original tomato adoption slice', { published: false });
  intermediate = await originalRecipe(sessions.owner, 'Original exact tomato stock', { laterDraft: true });
}, 240_000);
afterAll(async () => { await sessions?.close(); });

async function authoredPost(title: string, value: BlocksDocument): Promise<AuthoredPostResponse> {
  const body: AuthoredPostRequest = { profile: 'authored-post-v1',
    title: { value: title, language: 'en' }, language: 'en', document: value,
    actingSubject: sessions.owner.actingSubject! };
  const key = randomUUID();
  const created = await answer<AuthoredPostResponse>(sessions.owner.main('POST', '/v1/posts', body, key),
    201, 'Content adoption: POST /v1/posts must allocate native Post custody and an exact private Content draft');
  expect(created.author).toBe(sessions.owner.actingSubject);
  expect(await answer(sessions.owner.main('POST', '/v1/posts', body, key), 200))
    .toMatchObject({ ...created, replayed: true });
  return created;
}

// Original instruction wording, synthesized once with espeak-ng. Tests retain
// its exact WAV bytes and require no speech tool or remote recording service.
function originalRecording(): Uint8Array {
  return readFileSync(new URL('../../../../fixtures/recipes/original-tomato-method.wav', import.meta.url));
}

async function prepareSlice(): Promise<Slice> {
  const owner = sessions.owner, actor = owner.actingSubject!;
  // This is today's first missing boundary: native Post authoring is absent.
  // Do not replace the 201 assertion with acceptance of an arbitrary refusal.
  const post = await authoredPost('Original tomato method', document([paragraph('method', 'Stir the tomatoes into the stock.')]));
  await grantPersonaFixtureAuthority(owner, [
    { scope: 'semantic:create:root', action: 'semantic.change' },
    { scope: 'classification:define:global', action: 'classification.proposition.define' },
    { scope: 'classification:decide:global', action: 'statement.decide' },
    { scope: `media:owner:${actor}`, action: 'media.upload' },
    { scope: `media:owner:${actor}`, action: 'media.manage' },
  ]);
  const tomato = await answer<{ concept: string }>(owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null,
    labels: [{ language: 'en', value: 'Tomato' }], alternativeLabels: [], broader: [], narrower: [], actingSubject: actor,
  }), 201);
  await answer(owner.main('POST', `/v1/concepts/${short(tomato.concept)}/spoiler-hints`, {
    profile: 'concept-spoiler-hint-v1', context: { kind: 'global' }, hint: 'not-spoiler',
    expectedGeneration: '0', actingSubject: actor,
  }), 201);
  const tomatoMention: ResourceReference = { target: tomato.concept, selector: { grain: 'resource' } };
  const stockReference: ResourceReference = { target: intermediate.work,
    selector: { grain: 'occurrence', structure: intermediate.structure, revision: intermediate.revision,
      occurrence: intermediate.occurrenceIds[0]! } };
  const quantityOccurrence = recipe.occurrenceIds[1]!;
  const quantityReference: ResourceReference = { target: recipe.work,
    selector: { grain: 'occurrence', structure: recipe.structure, revision: recipe.revision, occurrence: quantityOccurrence } };
  const postDocument = document([
    { type: 'paragraph', attrs: { id: 'method' }, content: [{ type: 'text', text: 'Stir ' },
      resourceReference('tomato-mention', tomatoMention, 'tomato', true), { type: 'text', text: ' into the stock.' }] },
    resourceReference('stock-reference', stockReference, 'Tomato stock at the selected revision'),
    resourceReference('quantity-note-reference', quantityReference, 'The sauce tomato occurrence'),
    paragraph('quantity-note', 'Drain this tomato portion before measuring; keep the exact written quantity.'),
  ]);
  const edited = await answer<{ revisionId: string; byteDigest: string }>(owner.main('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    expectedHead: post.revisionId, document: postDocument, actingSubject: actor,
  }), 201);
  Object.assign(post, edited);
  const bytes = originalRecording();
  const reserved = await answer<{ asset: string; upload: string }>(owner.main('POST', '/v1/media/uploads', {
    profile: 'media-recording-upload-v1', asset: null, mediaType: 'audio/wav',
    byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
    disclosure: 'private', actingSubject: actor,
  }), 201);
  const recording = await answer<{ representation: string; revision: string; status: string }>(owner.main('PUT',
    `/v1/media/uploads/${reserved.upload}/bytes`, undefined, undefined,
    { bytes, headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.byteLength) } }), 201);
  expect(recording.status).toBe('activated');
  const recordingReference: ResourceReference = { target: `urn:rezics:media:asset:${reserved.asset}`,
    selector: { grain: 'representation', revision: recording.revision, representation: recording.representation } };
  const items: ProcedureItem[] = [{ id: 'sauce-section', type: 'HowToSection',
    name: { value: 'Sauce', language: 'en' }, items: [{ id: 'stir-step', type: 'HowToStep',
      document: document([paragraph('stir', 'Stir the drained tomatoes into the stock.'),
        resourceReference('procedure-tomato', tomatoMention, 'tomato'),
        resourceReference('procedure-stock', stockReference, 'Exact intermediate stock')]) }] },
  { id: 'empty-garnish', type: 'HowToSection', name: { value: 'Garnish', language: 'en' }, items: [] }];
  const procedureDocument = document([{ type: 'extensionBlock', attrs: { id: 'procedure',
    definition: 'https://rezics.com/definition/procedure-v1', version: '1', payload: { items },
    fallback: 'Sauce: stir the tomatoes into the stock. Garnish.' } }]);
  const procedure = await authoredPost('Procedure transformed from original recording', procedureDocument);
  const ai = await answer<{ agent: string; state: string }>(owner.main('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'service', displayName: 'Original recipe AI transformer',
  }), 201);
  expect(ai.state).toBe('active');
  const procedureReference = contentReference(procedure, 'procedure');
  const derivationCommand: ContentDerivationRequest = { profile: 'content-derivation-v1',
    output: procedureReference, inputs: [{ ...recordingReference,
      selector: { grain: 'representation', revision: recording.revision,
        representation: recording.representation } }],
    activity: { kind: 'transformation' }, responsibleAgent: ai.agent,
    expectedOutputHead: procedure.revisionId, actingSubject: actor };
  const derivationKey = randomUUID();
  const derivation = await answer<ContentDerivationRecord>(owner.main('POST', '/v1/content-derivations', derivationCommand, derivationKey), 201);
  expect(await answer(owner.main('POST', '/v1/content-derivations', derivationCommand, derivationKey), 200))
    .toMatchObject({ ...derivation, replayed: true });
  let head = recipe.revision;
  let adopted: string[] = [];
  let publicationHead: string | null = null;
  const stages: Stage[] = [];
  // Reuse the same procedure in two distinct occurrences, with one Content
  // revision and one native export document, rather than copying its body.
  const references = [contentReference(post), recordingReference, procedureReference, procedureReference];
  // These four revisions belong to the same Recipe. Every persona reads each
  // while it is the active publication, so history access is not assumed.
  for (const selected of [[references[0]!], [references[1]!], [references[2]!], references]) {
    const removed = stages.length ? adopted : recipe.occurrenceIds.slice(-2);
    // Existing Structure changes admit one operation kind per batch. Replacing
    // an ordered selection is two private revisions, then one publication;
    // neither the contract nor the test claims this is an atomic replacement.
    const detached = await answer<{ revision: string }>(owner.main('POST',
      `/v1/compositions/${short(recipe.structure)}/changes`, {
        profile: 'recipe-composition', expectedHead: head, actingSubject: actor,
        operations: removed.map(occurrence => ({ op: 'remove', occurrence })),
      }));
    head = detached.revision;
    const operations = selected.map(reference => ({ op: 'insert', parent: recipe.structure,
      position: 'last', role: 'instruction', target: reference.target,
      selection: { mode: 'fixed-revision', revision: 'revision' in reference.selector ? reference.selector.revision : '',
        selector: reference.selector } }));
    const command = { profile: 'recipe-composition', expectedHead: head, actingSubject: actor, operations };
    const key = randomUUID();
    const changed = await answer<{ revision: string; occurrences: string[] }>(owner.main('POST',
      `/v1/compositions/${short(recipe.structure)}/changes`, command, key));
    expect(await answer(owner.main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, command, key)))
      .toMatchObject({ revision: changed.revision, occurrences: changed.occurrences, replayed: true });
    head = changed.revision; adopted = changed.occurrences;
    const published = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: recipe.work,
      expectedWorkHead: recipe.workRevision, expectedMainVersion: recipe.mainVersion,
      structure: recipe.structure, expectedStructureHead: head, expectedPublicationHead: publicationHead,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }), 201);
    publicationHead = published.publicationDecision;
    const pages = {} as Record<PersonaName, InstructionPage>;
    for (const name of personas) pages[name] = await answer<InstructionPage>(sessions[name].main('GET', pagePath(sessions[name], head)));
    stages.push({ revision: head, references: selected, pages });
  }
  const privateContent = await answer<{ revisionId: string }>(owner.main('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: post.post, variantId: post.variantId,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: post.revisionId,
    document: document([paragraph('private-successor', privateText)]), actingSubject: actor,
  }), 201);
  const draft = await answer<{ revision: string }>(owner.main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: head, actingSubject: actor,
    operations: [{ op: 'update', occurrence: adopted[0], target: post.post,
      selection: { mode: 'fixed-revision', revision: privateContent.revisionId,
        selector: { grain: 'content', variantId: post.variantId, revision: privateContent.revisionId } } }],
  }));
  return { stages, references, post, procedure, postDocument, procedureDocument, derivation,
    draftRevision: draft.revision, privateContentRevision: privateContent.revisionId };
}

async function readInstructions(name: PersonaName) {
  const slice = await (preparation ??= prepareSlice());
  const person = sessions[name], final = slice.stages.at(-1)!;
  for (const stage of slice.stages) {
    const page = stage.pages[name];
    expect(page.revision).toBe(stage.revision);
    expect(page.instructions.map(item => item.reference)).toEqual(stage.references);
    expect(page.instructions.every(item => item.status === 'available')).toBe(true);
    expect(page.occurrences.length).toBeLessThanOrEqual(100);
    expect(page.cost.pages).toBeLessThanOrEqual(34);
    expect(page.next).toBeUndefined();
    expect(page.ingredients[0]?.amount).toEqual({ numerator: 9, denominator: 2 });
    expect(JSON.stringify(page)).not.toContain(privateText);
  }
  expect(final.pages[name].instructions[0]?.document).toEqual(slice.postDocument);
  expect(final.pages[name].instructions[2]?.document).toEqual(slice.procedureDocument);
  expect(final.pages[name].instructions[3]?.document).toEqual(slice.procedureDocument);
  expect(final.pages[name].instructions[2]?.occurrence).not.toBe(final.pages[name].instructions[3]?.occurrence);
  const pinned = await answer<InstructionPage>(person.main('GET', pagePath(person, final.revision)));
  expect(pinned.instructions).toEqual(final.pages[name].instructions);
  expect(JSON.stringify(pinned)).not.toContain(privateText);
  for (const [post, expectedDocument] of [[slice.post, slice.postDocument], [slice.procedure, slice.procedureDocument]] as const) {
    const exact = await answer<{ reference: { revisionId: string; byteDigest: string }; serializedJson: string;
      body: { document: BlocksDocument } }>(person.main('GET', `/v1/content-revisions/${post.revisionId}${query(person)}`));
    expect(exact.reference.revisionId).toBe(post.revisionId);
    expect(exact.reference.byteDigest).toBe(post.byteDigest);
    expect(exact.body.document).toEqual(expectedDocument);
    expect(createHash('sha256').update(exact.serializedJson).digest('hex')).toBe(post.byteDigest);
  }
  const recorded = pinned.instructions[1]!;
  expect(recorded.mediaUse).toBeString();
  if (recorded.reference.selector.grain !== 'representation') throw new Error('Recording must select a representation');
  const mediaPath = `/v1/media/representations/${recorded.reference.selector.representation}`;
  const mediaQuery = query(person, { use: recorded.mediaUse! });
  const metadata = await answer<{ representation: string; sha256: string }>(person.main('GET', `${mediaPath}${mediaQuery}`));
  const originalBytes = originalRecording();
  expect(metadata.representation).toBe(recorded.reference.selector.representation);
  expect(metadata.sha256).toBe(createHash('sha256').update(originalBytes).digest('hex'));
  const delivered = await person.main('GET', `${mediaPath}/bytes${mediaQuery}`);
  expect(delivered.status).toBe(200);
  expect(new Uint8Array(await delivered.arrayBuffer())).toEqual(new Uint8Array(originalBytes));
  const stock = await answer<{ revision: string }>(person.main('GET',
    `/v1/recipes/works/${short(intermediate.work)}${query(person, { revision: intermediate.revision })}`));
  expect(stock.revision).toBe(intermediate.revision);
  expect(JSON.stringify(stock)).not.toContain('PRIVATE DRAFT parsley');
  const provenance = await answer<{ items: ContentDerivationRecord[]; nextCursor: string | null }>(person.main('GET',
    `/v1/content-revisions/${slice.procedure.revisionId}/derivations${query(person, { limit: '20' })}`));
  expect(provenance.items).toContainEqual(slice.derivation);
  expect(provenance.nextCursor).toBeNull();
  expect(slice.derivation.activity.kind).toBe('transformation');
  expect(slice.derivation.responsibleAgent).not.toBe(slice.post.author);
  const nativePath = `/v1/recipes/${short(recipe.structure)}/export${query(person, { revision: final.revision, format: 'native' })}`;
  if (name === 'visitor') await answer(person.main('GET', nativePath), 401);
  else {
    const native = await answer<NativeRecipeExport>(person.main('GET', nativePath));
    expect(native.revision).toBe(final.revision);
    expect(native.losses).toEqual([]);
    expect(native.contents).toEqual(expect.arrayContaining([
      { reference: slice.references[0], document: slice.postDocument },
      { reference: slice.references[2], document: slice.procedureDocument },
    ]));
    expect(native.derivations).toContainEqual(slice.derivation);
    expect(native.occurrences.filter(item => item.selection).map(item => ({ target: item.target, selector: item.selection!.selector })))
      .toEqual(slice.references);
    // The intermediate Recipe remains an exact reference, not recursively
    // expanded Content and not retargeted to a later draft.
    expect(native.contents).toHaveLength(2);
    const exported = await answer<{ losses: { code: string; occurrence: string; pointer: string }[] }>(person.main('GET',
      `/v1/recipes/${short(recipe.structure)}/export${query(person, { revision: final.revision, format: 'schema-org' })}`));
    expect(exported.losses.map(loss => loss.code)).toEqual(expect.arrayContaining([
      'instruction-form-unsupported', 'reference-not-representable', 'derivation-not-representable',
    ]));
    expect(exported.losses.every(loss => loss.occurrence && loss.pointer)).toBe(true);
  }
  const privateContentPath = `/v1/content-revisions/${slice.privateContentRevision}${query(person)}`;
  const privateStructurePath = `/v1/compositions/${short(recipe.structure)}/revisions/${short(slice.draftRevision)}${query(person)}`;
  if (name === 'owner') {
    expect(JSON.stringify(await answer(person.main('GET', privateContentPath)))).toContain(privateText);
    expect(await answer(person.main('GET', privateStructurePath))).toMatchObject({ revision: slice.draftRevision });
  } else {
    for (const [hidden, absent] of [[privateContentPath, `/v1/content-revisions/${randomUUID()}${query(person)}`],
      [privateStructurePath, `/v1/compositions/${short(recipe.structure)}/revisions/${randomUUID()}${query(person)}`]]) {
      const refused = await person.main('GET', hidden!), missing = await person.main('GET', absent!);
      expect(refused.status).toBe(404);
      expect([refused.status, await refused.text()]).toEqual([missing.status, await missing.text()]);
    }
    await answer(person.main('POST', `/v1/compositions/${short(recipe.structure)}/changes`, {
      profile: 'recipe-composition', expectedHead: slice.draftRevision,
      actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
      operations: [{ op: 'remove', occurrence: pinned.instructions[0]!.occurrence }],
    }), name === 'visitor' ? 401 : 403);
  }
  // Every persona sees the author Person, never the transformer as author.
  const credits = await answer<{ items: { role: string; agent: string }[] }>(person.main('GET',
    `/v1/works/${short(recipe.work)}/credits${query(person)}`));
  expect(credits.items.filter(item => item.role === 'author').map(item => item.agent)).toEqual([sessions.owner.actingSubject!]);
}

outcomeTest(instructions, 'visitor', () => readInstructions('visitor'));
outcomeTest(instructions, 'stranger', () => readInstructions('stranger'));
outcomeTest(instructions, 'member', () => readInstructions('member'));
outcomeTest(instructions, 'owner', () => readInstructions('owner'));
outcomeTest(instructions, 'moderator', () => readInstructions('moderator'));
outcomeTest(instructions, 'operator', () => readInstructions('operator'));

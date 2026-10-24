import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AuditCommandReceipt, AuditOriginals } from '../fixtures/audit-corpus-contract.ts';
import { assertPublicDomainNativeCreation, assertPublicDomainOriginalWorks, type PublicDomainSelectedCorpus,
  type PublicDomainCorpus, type PublicRecipe, type RealBook, type Measure } from '../fixtures/catalogue-public-domain.ts';
import { assertPublicDomainWorkAdmission, assertPublicDomainSelectedPremises, assertPublicDomainBorrowedBook,
  assertPublicRecipeAdmission, attachPublicDomainBook, loadPublicDomainBorrowedBook, publishPublicRecipe } from '../support/catalogue-public-domain.ts';
import { personaNames, type PersonaSessions } from '../support/personas.ts';

// Synthetic metadata exercises admission only; none of these IDs or receipts is product evidence.
const id = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const actor = id(10_000), work = id(20_000), mainVersion = id(20_001);
let directory: string, files = 0;
beforeAll(() => {
  mkdirSync('.temp', { recursive: true });
  directory = relative(resolve('.'), mkdtempSync(resolve('.temp/public-domain-admission-unit-')));
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function pinJson(value: unknown) {
  const file = join(directory, `${++files}.json`), bytes = JSON.stringify(value) + '\n';
  writeFileSync(file, bytes);
  return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function originals(): Pick<AuditOriginals, 'format' | 'bindings'> {
  return { format: 'audit-original-bindings-v1', bindings: Array.from({ length: 113 }, (_, index) => ({
    sourceKey: `unit-original-${index}`, resource: id(index), mainVersion: id(1000 + index), revision: id(2000 + index),
    readPath: `/v1/works/${id(index).slice(-36)}`, resourcePointer: '/work',
    mainVersionPointer: '/mainVersion', revisionPointer: '/workRevision',
  })) };
}
function corpus() {
  const ledger = originals();
  return { originals: pinJson(ledger), importedWorks: ledger.bindings.map(binding => binding.resource) };
}
function creation(): AuditCommandReceipt {
  return { id: 'unit-native-create', phase: 'native-content', method: 'POST', path: '/v1/works',
    key: 'unit-native-create', caller: { realm: 'local', persona: 'owner', accountId: 'unit-account', actingSubject: actor },
    body: { profile: 'metadata-only-v1', authoring: 'own-work', actingSubject: actor, title: 'Unit native Work' },
    startedAt: 1000, finishedAt: 1001, status: 201,
    answer: { work, mainVersion, workRevision: id(20_002), mainRevision: id(20_003), admissionId: 'unit-admission',
      sourcePosition: { datasetId: 'product', dataEpoch: 'unit-epoch', sequence: '1' }, replayed: false } };
}
const answer = (receipt: AuditCommandReceipt) => receipt.answer as Record<string, unknown>;
function receiptPin(receipt = creation()) {
  const pin = pinJson(receipt);
  return { path: pin.file, sha256: pin.sha256 };
}

test('original targets need no new creation receipt and retain the exact original identity set', () => {
  const manifest = corpus(), before = structuredClone(manifest);
  expect(() => assertPublicDomainWorkAdmission(manifest,
    [{ work: manifest.importedWorks[0]! }, { work: manifest.importedWorks[112]! }])).not.toThrow();
  expect(manifest).toEqual(before);
});

test('additional native Book and Recipe use actual receipt pins without entering the original 113', () => {
  const manifest = corpus(), before = structuredClone(manifest), book = creation(), recipe = creation();
  answer(book).work = id(30_000);
  recipe.status = 200;
  answer(recipe).replayed = true;
  const targets = [{ work: id(30_000), creationReceipt: receiptPin(book) },
    { work, mainVersion, workRevision: id(20_010), creationReceipt: receiptPin(recipe) }];
  // The creation revision predates later metadata commands. No conversion/captured-byte proof is required.
  expect(() => assertPublicDomainWorkAdmission(manifest, targets)).not.toThrow();
  expect(manifest).toEqual(before);
  expect(manifest.importedWorks).not.toContain(work);
  expect(manifest.importedWorks).not.toContain(id(30_000));
});

test('an additional native ID without a retained receipt stays a premise blocker', () => {
  expect(() => assertPublicDomainWorkAdmission(corpus(), [{ work }])).toThrow('missing its creation receipt');
});

test('a self-declared inline success is not an existing producer receipt pin', () => {
  const declared = { status: 201, answer: { work, mainVersion } } as unknown as { path: string; sha256: string };
  expect(() => assertPublicDomainWorkAdmission(corpus(), [{ work, creationReceipt: declared }]))
    .toThrow('existing producer file/digest pin');
});

test('pinning a bare successful object does not turn it into a native owner receipt', () => {
  const pin = pinJson({ status: 201, answer: { work, mainVersion } });
  expect(() => assertPublicDomainWorkAdmission(corpus(), [{ work,
    creationReceipt: { path: pin.file, sha256: pin.sha256 } }])).toThrow('actual successful native creation owner receipt');
});

test('the original ledger pin is mandatory even when all selected targets are original', () => {
  const manifest = corpus();
  delete (manifest as Partial<typeof manifest>).originals;
  expect(() => assertPublicDomainWorkAdmission(manifest, [{ work: manifest.importedWorks[0]! }]))
    .toThrow('original 113 association ledger');
});

for (const kind of ['missing', 'duplicate', 'replacement', 'appended-native'] as const) {
  test(`original identity conservation refuses ${kind} entries`, () => {
    const manifest = corpus();
    if (kind === 'missing') manifest.importedWorks.pop();
    else if (kind === 'duplicate') manifest.importedWorks[0] = manifest.importedWorks[1]!;
    else if (kind === 'replacement') manifest.importedWorks[0] = work;
    else manifest.importedWorks.push(work);
    expect(() => assertPublicDomainWorkAdmission(manifest, [])).toThrow('exactly the original 113');
  });
}

for (const field of ['sourceKey', 'resource', 'mainVersion'] as const) {
  test(`the retained ledger refuses duplicate ${field} associations`, () => {
    const ledger = originals(), importedWorks = ledger.bindings.map(binding => binding.resource);
    ledger.bindings[0]![field] = ledger.bindings[1]![field];
    expect(() => assertPublicDomainOriginalWorks(importedWorks, ledger)).toThrow('association is duplicated');
  });
}

test('a missing original association is refused independently of the declared Work list', () => {
  const ledger = originals(), importedWorks = ledger.bindings.map(binding => binding.resource);
  ledger.bindings.pop();
  expect(() => assertPublicDomainOriginalWorks(importedWorks, ledger)).toThrow('original 113 association ledger');
});

test('receipt bytes cannot be changed behind an existing digest', () => {
  const receipt = creation(), pin = receiptPin(receipt);
  answer(receipt).work = id(30_000);
  writeFileSync(pin.path, JSON.stringify(receipt));
  expect(() => assertPublicDomainWorkAdmission(corpus(), [{ work, creationReceipt: pin }]))
    .toThrow('native creation receipt pinned evidence is invalid');
});

test('original source associations cannot be altered behind the retained ledger digest', () => {
  const manifest = corpus(), ledger = originals();
  ledger.bindings[0]!.sourceKey = 'changed-source-association';
  writeFileSync(manifest.originals.file, JSON.stringify(ledger));
  expect(() => assertPublicDomainWorkAdmission(manifest, []))
    .toThrow('original 113 association ledger pinned evidence is invalid');
});

test('a receipt for another Work or main Version cannot admit the selected Recipe', () => {
  const manifest = corpus(), pin = receiptPin();
  expect(() => assertPublicDomainWorkAdmission(manifest, [{ work: id(30_000), creationReceipt: pin }]))
    .toThrow('bound to this target');
  expect(() => assertPublicDomainWorkAdmission(manifest, [{ work, mainVersion: id(30_001), creationReceipt: pin }]))
    .toThrow('bound to this target');
});

test('receipt paths must stay inside this isolated worktree evidence area', () => {
  const pin = receiptPin();
  expect(() => assertPublicDomainWorkAdmission(corpus(), [{ work,
    creationReceipt: { ...pin, path: resolve(pin.path) } }])).toThrow('pinned evidence is invalid');
});

const refusals: Array<[string, (receipt: AuditCommandReceipt) => void]> = [
  ['read', receipt => { receipt.method = 'GET'; }],
  ['unrelated command', receipt => { receipt.path = '/v1/source-annotations'; }],
  ['pending command', receipt => { receipt.status = 202; }],
  ['failed command', receipt => { receipt.status = 403; }],
  ['transport failure', receipt => { receipt.error = 'connection lost'; }],
  ['missing answer', receipt => { receipt.answer = null; }],
  ['owner API redirect', receipt => { receipt.status = 200; receipt.answer = { outcome: 'use-owner-api' }; }],
  ['missing request key', receipt => { receipt.key = null; }],
  ['non-native creation profile', receipt => { receipt.body = { profile: 'source-adopt-v1' }; }],
  ['missing authenticated caller', receipt => { receipt.caller.accountId = null; }],
  ['mismatched acting subject', receipt => { receipt.caller.actingSubject = id(30_001); }],
  ['unfinished command', receipt => { receipt.finishedAt = receipt.startedAt - 1; }],
  ['missing creation revisions', receipt => { delete answer(receipt).workRevision; }],
  ['missing source position', receipt => { delete answer(receipt).sourcePosition; }],
  ['replay with fresh status', receipt => { answer(receipt).replayed = true; }],
  ['fresh answer with replay status', receipt => { receipt.status = 200; }],
];
for (const [name, alter] of refusals) {
  test(`${name} cannot stand in for successful native creation`, () => {
    const receipt = creation();
    alter(receipt);
    expect(() => assertPublicDomainNativeCreation({ work, mainVersion }, receipt))
      .toThrow('actual successful native creation owner receipt');
  });
}

function citation() {
  const exact = 'Synthetic unit source paragraph with enough words for a chapter body. '.repeat(5);
  return { ...pinJson(exact), exact };
}
function unitBook(): RealBook {
  const evidence = citation();
  return { work, creationReceipt: receiptPin(), title: 'Unit Book', language: 'en',
    description: { value: 'Unit description', language: 'en', evidence },
    author: { agent: actor, name: 'Unit author', evidence }, composition: id(40_000), compositionRevision: id(40_001),
    releases: [1, 2].map(index => ({ id: id(40_010 + index), revision: id(40_020 + index), realization: id(40_030),
      realizationRevision: id(40_031), language: 'en', platform: `unit-platform-${index}`, evidence })),
    chapters: [1, 2].map(index => ({ occurrence: id(40_040 + index), parent: id(40_000), target: id(40_050 + index),
      selectedRevision: id(40_060 + index), body: evidence, bodyText: evidence.exact })) };
}
function unitRecipe(): PublicRecipe {
  const evidence = citation(), structure = id(50_000);
  const measure = (kind: Measure['kind']): Measure => ({ kind, value: { numerator: 2, denominator: 1 },
    basis: 'whole-recipe', coverage: 'complete', provenance: 'source-stated' });
  return { work, creationReceipt: receiptPin(), workRevision: id(20_010), mainVersion, structure, revision: id(50_001),
    publisher: 'owner', source: { record: id(50_002), observation: id(50_003), author: 'Unit author',
      url: 'https://example.invalid/unit-source', license: null }, title: 'Unit Recipe', language: 'en',
    order: [id(50_010), id(50_011), id(50_020)],
    ingredients: [0, 1].map(index => ({ occurrence: id(50_010 + index), parent: structure, evidence,
      qualifier: { type: 'ingredient-line', name: 'flour', originalText: { value: 'half flour', language: 'en' },
        amount: { numerator: 1, denominator: 2 }, optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'parsed' } })),
    steps: [{ occurrence: id(50_020), parent: structure, evidence, qualifier: { type: 'recipe-step',
      instructionText: { value: 'Combine', language: 'en' }, usesIngredient: [id(50_010)], media: [], scaling: 'linear' } }],
    measures: ['servings', 'cooking-duration'].map(kind => ({ value: measure(kind as Measure['kind']), evidence })),
    nutrition: 'absent', substitutions: [] };
}

function citedRecipe() {
  const recipe = unitRecipe(), terms = citation();
  recipe.source = { author: recipe.source.author, url: recipe.source.url, license: recipe.source.license };
  recipe.rightsAssessmentId = id(70_000).slice(-36);
  recipe.publicationDecision = id(70_001);
  recipe.selectedGeneration = 'unit-selected-generation';
  recipe.sourceRoot = 'unit-source-root';
  recipe.citation = { kind: 'manual-citation', ...recipe.source, rightsAssessmentId: recipe.rightsAssessmentId, transcriber: actor };
  const receipt = (name: string, path: string, body: object, result: object, startedAt: number): AuditCommandReceipt => ({
    ...creation(), id: `unit-${name}`, key: `unit-${name}`, path, body, answer: result,
    startedAt, finishedAt: startedAt + 1,
  } as AuditCommandReceipt);
  const rights = receipt('rights', '/v1/rights/use-assessments', {
    profile: 'rights-use-assessment-v1', actingSubject: actor, material: { scopeKind: 'work', workId: work,
      component: 'body', provider: null, namespace: null, sourceRecordId: null, contentVariantId: null, mediaAsset: null },
    expressionKind: 'expression', family: 'data_rights', useKind: 'redistribution', useScope: 'rezics:public-text',
    basis: 'public_domain', outcome: 'supported', expectedAssessment: null, idempotencyKey: 'unit-rights',
    evidence: { source: { ...recipe.ingredients[0]!.evidence, url: recipe.source.url },
      terms: { ...terms, url: 'https://example.invalid/unit-terms' } },
  }, { profile: 'rights-use-assessment-v1', assessmentId: recipe.rightsAssessmentId, materialId: id(70_002).slice(-36),
    expressionKind: 'expression', family: 'data_rights', useKind: 'redistribution', useScope: 'rezics:public-text',
    basis: 'public_domain', outcome: 'supported', predecessor: null, replayed: false }, 1002);
  const publication = receipt('publication', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work, actingSubject: actor,
    expectedWorkHead: recipe.workRevision, expectedMainVersion: mainVersion,
    structure: recipe.structure, expectedStructureHead: recipe.revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'public-domain', citation: recipe.source, rightsAssessmentId: recipe.rightsAssessmentId,
  }, { profile: 'work-structure-publication-v1', operation: 'publish', work, mainVersion,
    structure: recipe.structure, structureRevision: recipe.revision, structureProfile: 'recipe-composition',
    publicationDecision: recipe.publicationDecision, selectedGeneration: recipe.selectedGeneration, sourceRoot: recipe.sourceRoot,
    predecessor: null, replayed: false }, 1004);
  const read = (name: string, path: string, result: object, startedAt: number): AuditCommandReceipt => ({
    ...receipt(name, `${path}?${new URLSearchParams({ actingSubject: actor })}`, {}, result, startedAt),
    method: 'GET', body: null, key: null, status: 200,
  });
  const header = read('cited-header', `/v1/works/${work.slice(-36)}`, {
    id: work, revision: recipe.workRevision, mainVersion, disclosure: 'public', publicationState: 'published',
    structurePublicationHead: recipe.publicationDecision, rights: { basis: 'public-domain', source: structuredClone(recipe.citation) },
  }, 1006);
  const published = read('published-recipe', `/v1/recipes/works/${work.slice(-36)}`, {
    profile: 'recipe-work-page-v1', structure: recipe.structure, revision: recipe.revision,
    occurrences: [], ingredients: [], measures: recipe.measures.map(item => structuredClone(item.value)),
  }, 1008);
  recipe.observedSource = structuredClone(recipe.citation);
  recipe.publishedRecipeRead = structuredClone(published.answer) as unknown as PublicRecipe['publishedRecipeRead'];
  recipe.observedMeasures = structuredClone(answer(published).measures) as Measure[];
  return { recipe, rights, publication, header, published };
}
function pinCitedRecipe(input: ReturnType<typeof citedRecipe>) {
  input.recipe.rightsReceipt = receiptPin(input.rights);
  input.recipe.publicationReceipt = receiptPin(input.publication);
  input.recipe.sourceReceipt = receiptPin(input.header);
  input.recipe.publishedRecipeReceipt = receiptPin(input.published);
  return input.recipe;
}

test('retained Source admission keeps the existing representation and requires both native Source identities', () => {
  const recipe = unitRecipe();
  expect(() => assertPublicRecipeAdmission(recipe)).not.toThrow();
  for (const field of ['record', 'observation'] as const) {
    const incomplete = structuredClone(recipe);
    delete (incomplete.source as Partial<typeof incomplete.source>)[field];
    expect(() => assertPublicRecipeAdmission(incomplete)).toThrow('both native identities');
  }
  recipe.citation = citedRecipe().recipe.citation;
  expect(() => assertPublicRecipeAdmission(recipe)).toThrow('cannot masquerade');
});

test('independent citation admits only separate actual creation/Rights/publication/read receipts without fabricating Source IDs', () => {
  const recipe = pinCitedRecipe(citedRecipe()), before = structuredClone(recipe);
  expect(() => assertPublicRecipeAdmission(recipe)).not.toThrow();
  expect(() => assertPublicDomainSelectedPremises(selected({ richRecipe: recipe }), 'recipe')).not.toThrow();
  expect(recipe).toEqual(before);
  expect('record' in recipe.source).toBe(false);
  expect('observation' in recipe.source).toBe(false);
});

for (const field of ['creationReceipt', 'rightsReceipt', 'publicationReceipt', 'sourceReceipt', 'publishedRecipeReceipt',
  'citation', 'rightsAssessmentId', 'publicationDecision', 'selectedGeneration', 'sourceRoot',
  'observedSource', 'publishedRecipeRead', 'observedMeasures'] as const) {
  test(`independent citation refuses missing ${field} before outcomes`, () => {
    const recipe = pinCitedRecipe(citedRecipe());
    delete recipe[field];
    expect(() => assertPublicRecipeAdmission(recipe)).toThrow('TEST PREMISE');
  });
}

test('unexecuted references or inline expected success cannot admit an independent citation', () => {
  const recipe = citedRecipe().recipe;
  recipe.rightsReceipt = { $audit: 'ref', from: 'receipt:unexecuted-rights', pointer: '' } as unknown as PublicRecipe['rightsReceipt'];
  expect(() => assertPublicRecipeAdmission(recipe)).toThrow('existing producer file/digest pin');
  recipe.rightsReceipt = { status: 201, answer: { outcome: 'supported' } } as unknown as PublicRecipe['rightsReceipt'];
  expect(() => assertPublicRecipeAdmission(recipe)).toThrow('existing producer file/digest pin');
});

type CitedInput = ReturnType<typeof citedRecipe>;
const citationRefusals: Array<[string, (input: CitedInput) => void]> = [
  ['failed Rights', input => { input.rights.status = 403; }],
  ['transport error', input => { input.rights.error = 'unit transport error'; }],
  ['another Rights Work', input => { (input.rights.body as Record<string, unknown>).material = { scopeKind: 'work', workId: id(90_000) }; }],
  ['unsupported actual Rights', input => { answer(input.rights).outcome = 'unsupported'; }],
  ['missing actual Rights profile', input => { delete answer(input.rights).profile; }],
  ['another Rights use', input => { answer(input.rights).useScope = 'unit:private-use'; }],
  ['stale Rights predecessor', input => { answer(input.rights).predecessor = id(90_000).slice(-36); }],
  ['another assessment', input => { answer(input.rights).assessmentId = id(90_000).slice(-36); }],
  ['different receipt owner', input => { input.header.caller.accountId = 'unit-another-account'; }],
  ['different publisher persona', input => { input.publication.caller.persona = 'operator'; }],
  ['read before publication', input => { input.published.startedAt = 1001; input.published.finishedAt = 1002; }],
  ['stale Work head', input => { (input.publication.body as Record<string, unknown>).expectedWorkHead = id(90_000); }],
  ['stale Structure head', input => { (input.publication.body as Record<string, unknown>).expectedStructureHead = id(90_000); }],
  ['stale publication CAS', input => { answer(input.publication).predecessor = id(90_000); }],
  ['wrong publication assessment', input => { (input.publication.body as Record<string, unknown>).rightsAssessmentId = id(90_000).slice(-36); }],
  ['fabricated Source observation', input => { (input.publication.body as Record<string, unknown>).sourceObservation = id(90_000); }],
  ['altered citation', input => { (input.publication.body as Record<string, unknown>).citation = { ...input.recipe.source, author: 'Another author' }; }],
  ['wrong publication decision', input => { answer(input.publication).publicationDecision = id(90_000); }],
  ['wrong selected generation', input => { answer(input.publication).selectedGeneration = 'another-generation'; }],
  ['wrong source root', input => { answer(input.publication).sourceRoot = 'another-root'; }],
  ['stale current publication head', input => { answer(input.header).structurePublicationHead = id(90_000); }],
  ['another current Work', input => { answer(input.header).id = id(90_000); }],
  ['wrong current citation', input => { answer(input.header).rights = { basis: 'public-domain', source: { ...input.recipe.citation, url: 'https://example.invalid/other' } }; }],
  ['wrong read target', input => { input.published.path = `/v1/recipes/works/${id(90_000).slice(-36)}?actingSubject=${actor}`; }],
  ['wrong read actor', input => { input.published.path = `/v1/recipes/works/${work.slice(-36)}?actingSubject=${id(90_000)}`; }],
  ['extra read selector', input => { input.published.path += '&servings=3'; }],
  ['failed actual read', input => { input.published.status = 404; }],
  ['null actual read', input => { input.published.answer = null; }],
  ['different read revision', input => { answer(input.published).revision = id(90_000); }],
];
for (const [name, alter] of citationRefusals) {
  test(`independent citation refuses ${name}`, () => {
    const input = citedRecipe();
    alter(input);
    expect(() => assertPublicRecipeAdmission(pinCitedRecipe(input))).toThrow('TEST PREMISE');
  });
}

test('citation receipt and Rights evidence digests/locality remain mandatory', () => {
  const input = citedRecipe(), recipe = pinCitedRecipe(input);
  writeFileSync(recipe.publicationReceipt!.path, JSON.stringify({ ...input.publication, status: 403 }));
  expect(() => assertPublicRecipeAdmission(recipe)).toThrow('pinned evidence is invalid');
  pinCitedRecipe(input);
  recipe.sourceReceipt!.path = resolve(recipe.sourceReceipt!.path);
  expect(() => assertPublicRecipeAdmission(recipe)).toThrow('pinned evidence is invalid');
  pinCitedRecipe(input);
  const evidence = (input.rights.body as Record<string, unknown>).evidence as Record<string, Record<string, unknown>>;
  evidence.terms!.sha256 = '0'.repeat(64);
  expect(() => assertPublicRecipeAdmission(pinCitedRecipe(input))).toThrow('Recipe Rights source pinned evidence is invalid');
});

test('observed measures stay bound to the actual read while unchanged expected values remain the outcome oracle', () => {
  const recipe = pinCitedRecipe(citedRecipe());
  recipe.measures[0]!.value.value.numerator = 999;
  // A product mismatch belongs to the original assertions; admission cannot rewrite either side.
  expect(() => assertPublicRecipeAdmission(recipe)).not.toThrow();
  recipe.observedMeasures = recipe.measures.map(item => structuredClone(item.value));
  expect(() => assertPublicRecipeAdmission(recipe)).toThrow('separately from expected measures');
});

test('independent NHLBI unknown/pepper-only partial metadata cannot qualify the original full nutrition matrix', () => {
  const input = citedRecipe(), evidence = input.recipe.ingredients[0]!.evidence;
  input.recipe.nutrition = 'stated';
  for (let index = 0; index < 10; index++) input.recipe.measures.push({ evidence, value: { kind: 'nutrient',
    nutrient: `unit:nutrient-${index}`, unit: 'https://qudt.org/vocab/unit/MilliGM', basis: 'per-serving',
    value: index === 9 ? { numerator: 5, denominator: 16 } : { numerator: index + 1, denominator: 1 },
    coverage: index === 9 ? 'partial' : 'unknown', provenance: index === 9 ? 'computed' : 'source-stated' } });
  answer(input.published).measures = input.recipe.measures.map(item => structuredClone(item.value));
  input.recipe.publishedRecipeRead = structuredClone(input.published.answer) as unknown as PublicRecipe['publishedRecipeRead'];
  input.recipe.observedMeasures = structuredClone(answer(input.published).measures) as Measure[];
  const recipe = pinCitedRecipe(input), before = structuredClone(recipe.measures);
  expect(() => assertPublicDomainSelectedPremises(selected({ richRecipe: recipe }), 'recipe')).not.toThrow();
  expect(() => assertPublicDomainSelectedPremises(selected({ noNutritionRecipe: unitRecipe(), nutritionRecipes: [recipe] }),
    'nutrition')).toThrow('retained nutrition evidence must exercise');
  expect(recipe.measures).toEqual(before);
});

test('already published independent Recipe setup only verifies anonymous reads and never republishes or grants', async () => {
  const input = citedRecipe(), recipe = pinCitedRecipe(input), calls: string[] = [];
  const people = { owner: { actingSubject: actor }, visitor: { main: async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    return Response.json(path.startsWith('/v1/works/') ? input.header.answer : input.published.answer);
  } } } as unknown as PersonaSessions;
  await publishPublicRecipe(people, recipe);
  expect(calls).toEqual([`GET /v1/works/${work.slice(-36)}`, `GET /v1/recipes/works/${work.slice(-36)}`]);
  calls.length = 0;
  answer(input.header).structurePublicationHead = id(90_000);
  await expect(publishPublicRecipe(people, recipe)).rejects.toThrow('current publication head');
  expect(calls).toEqual([`GET /v1/works/${work.slice(-36)}`]);
  calls.length = 0;
  people.owner.actingSubject = id(90_000);
  await expect(publishPublicRecipe(people, recipe)).rejects.toThrow('publisher differs');
  expect(calls).toEqual([]);
});
function selected(fields: Partial<Pick<PublicDomainSelectedCorpus, 'book' | 'richRecipe' | 'noNutritionRecipe' | 'nutritionRecipes'>>)
  : PublicDomainSelectedCorpus {
  // This helper tests selection metadata; actual Git execution/backup checks remain in the loader.
  return { ...corpus(), profile: 'catalogue-public-domain-corpus-v1',
    productRevision: '69eac3ceeaf885be70205a70248bc951e9d81cc9', backup: directory,
    preparationMs: 1, preparationQaRun: 'unit-selection', personas: {} as PublicDomainSelectedCorpus['personas'], ...fields };
}
function unitNutrition() {
  const noNutritionRecipe = unitRecipe(), recipe = unitRecipe(), evidence = citation();
  recipe.nutrition = 'stated';
  for (const [index, coverage] of (['complete', 'partial', 'unknown'] as const).entries()) {
    recipe.measures.push({ evidence, value: { kind: 'nutrient', nutrient: id(60_000), unit: id(60_001),
      value: { numerator: index + 1, denominator: 1 }, basis: index ? 'whole-recipe' : 'per-serving', coverage,
      provenance: (['declared', 'source-stated', 'computed'] as const)[index]! } });
  }
  recipe.substitutions.push({ alternative: id(50_011), for: id(50_010), declaredBy: actor, evidence });
  return selected({ noNutritionRecipe, nutritionRecipes: [recipe] });
}

test('Book selection admits genuine Book metadata without any Recipe or nutrition branch', () => {
  const manifest = selected({ book: unitBook() }), before = structuredClone(manifest);
  expect(() => assertPublicDomainSelectedPremises(manifest, 'book')).not.toThrow();
  expect(manifest).toEqual(before);
  expect('nutritionRecipes' in manifest).toBe(false);
  expect(() => assertPublicDomainSelectedPremises(manifest, 'recipe')).toThrow('selected rich Recipe');
  expect(() => assertPublicDomainSelectedPremises(manifest, 'nutrition')).toThrow('entire nutrition matrix');
});

test('Recipe selection admits the unchanged rich Recipe without a Book or invented nutrient matrix', () => {
  const manifest = selected({ richRecipe: unitRecipe() }), before = structuredClone(manifest);
  expect(() => assertPublicDomainSelectedPremises(manifest, 'recipe')).not.toThrow();
  expect(manifest).toEqual(before);
  expect('book' in manifest).toBe(false);
  expect(() => assertPublicDomainSelectedPremises(manifest, 'nutrition')).toThrow('entire nutrition matrix');
});

test('nutrition selection retains the full original matrix without requiring an unrelated Book', () => {
  expect(() => assertPublicDomainSelectedPremises(unitNutrition(), 'nutrition')).not.toThrow();
});

for (const kind of ['one-release', 'one-chapter', 'short-body', 'unquoted-body'] as const) {
  test(`Book selection still refuses ${kind}`, () => {
    const book = unitBook();
    if (kind === 'one-release') book.releases.pop();
    else if (kind === 'one-chapter') book.chapters.pop();
    else book.chapters[0]!.bodyText = kind === 'short-body' ? 'Too short' : 'Absent text. '.repeat(30);
    expect(() => assertPublicDomainSelectedPremises(selected({ book }), 'book')).toThrow('genuine releases and meaningful chapter bodies');
  });
}

for (const kind of ['no-steps', 'incomplete-order', 'zero-servings', 'no-duplicate-use', 'unlinked-step', 'no-fraction', 'no-duration'] as const) {
  test(`Recipe selection still refuses ${kind}`, () => {
    const richRecipe = unitRecipe();
    if (kind === 'no-steps') richRecipe.steps = [];
    else if (kind === 'incomplete-order') richRecipe.order.pop();
    else if (kind === 'zero-servings') richRecipe.measures[0]!.value.value.numerator = 0;
    else if (kind === 'no-duplicate-use') richRecipe.ingredients[1]!.qualifier.name = 'salt';
    else if (kind === 'unlinked-step') richRecipe.steps[0]!.qualifier.usesIngredient = [];
    else if (kind === 'no-fraction') for (const item of richRecipe.ingredients) item.qualifier.amount!.denominator = 1;
    else richRecipe.measures = richRecipe.measures.filter(item => item.value.kind !== 'cooking-duration');
    expect(() => assertPublicDomainSelectedPremises(selected({ richRecipe }), 'recipe')).toThrow('TEST PREMISE');
  });
}

for (const kind of ['empty-matrix', 'one-basis', 'one-coverage', 'one-provenance', 'no-substitute', 'invented-nutrition'] as const) {
  test(`nutrition selection still refuses ${kind}`, () => {
    const manifest = unitNutrition(), recipe = manifest.nutritionRecipes![0]!;
    if (kind === 'empty-matrix') manifest.nutritionRecipes = [];
    else if (kind === 'no-substitute') recipe.substitutions = [];
    else if (kind === 'invented-nutrition') manifest.noNutritionRecipe!.measures.push(recipe.measures[2]!);
    else for (const item of recipe.measures.filter(item => item.value.kind === 'nutrient')) {
      if (kind === 'one-basis') item.value.basis = 'per-serving';
      else if (kind === 'one-coverage') item.value.coverage = 'complete';
      else item.value.provenance = 'declared';
    }
    expect(() => assertPublicDomainSelectedPremises(manifest, 'nutrition')).toThrow('TEST PREMISE');
  });
}

test('selection never bypasses original identity, additional native receipt or supplied citation checks', () => {
  const manifest = selected({ book: unitBook() });
  manifest.importedWorks[0] = work;
  expect(() => assertPublicDomainSelectedPremises(manifest, 'book')).toThrow('exactly the original 113');
  manifest.importedWorks = originals().bindings.map(binding => binding.resource);
  delete manifest.book!.creationReceipt;
  expect(() => assertPublicDomainSelectedPremises(manifest, 'book')).toThrow('missing its creation receipt');
  manifest.book!.creationReceipt = receiptPin();
  manifest.richRecipe = unitRecipe();
  manifest.richRecipe.ingredients[0]!.evidence.sha256 = '0'.repeat(64);
  expect(() => assertPublicDomainSelectedPremises(manifest, 'book')).toThrow('source digest/quote is invalid');
});

test('the retained array ledger accepts the same exact original identities without changing its entries', () => {
  const bindings = originals().bindings, works = bindings.map(binding => binding.resource), before = structuredClone(bindings);
  expect(() => assertPublicDomainOriginalWorks(works, bindings)).not.toThrow();
  expect(bindings).toEqual(before);
});

for (const kind of ['missing', 'duplicate-source', 'duplicate-work', 'duplicate-main', 'replacement',
  'missing-revision', 'missing-read-path', 'invalid-pointer'] as const) {
  test(`array ledger retains original conservation refusal for ${kind}`, () => {
    const bindings = originals().bindings, works = bindings.map(binding => binding.resource);
    if (kind === 'missing') bindings.pop();
    else if (kind === 'duplicate-source') bindings[1]!.sourceKey = bindings[0]!.sourceKey;
    else if (kind === 'duplicate-work') bindings[1]!.resource = bindings[0]!.resource;
    else if (kind === 'duplicate-main') bindings[1]!.mainVersion = bindings[0]!.mainVersion;
    else if (kind === 'replacement') bindings[1]!.resource = work;
    else if (kind === 'missing-revision') bindings[1]!.revision = '';
    else if (kind === 'missing-read-path') bindings[1]!.readPath = '';
    else bindings[1]!.resourcePointer = 'not-a-pointer';
    expect(() => assertPublicDomainOriginalWorks(works, bindings)).toThrow('TEST PREMISE');
  });
}

test('a rewritten array with a newly declared digest cannot substitute for the pinned original bytes', () => {
  const bindings = originals().bindings;
  expect(() => assertPublicDomainWorkAdmission({ importedWorks: bindings.map(binding => binding.resource),
    originals: pinJson(bindings) }, [])).toThrow('pinned original digest');
});

test('all six releases retain actual null unknown correspondence and platforms without filtering or invention', () => {
  const book = unitBook(), source = book.releases[0]!;
  book.releases = Array.from({ length: 6 }, (_, index) => ({ ...source, id: id(70_000 + index),
    realization: index ? source.realization : null, realizationRevision: index ? source.realizationRevision : null,
    language: index ? source.language : null, platform: index < 3 ? null : source.platform }));
  const before = structuredClone(book);
  expect(() => assertPublicDomainSelectedPremises(selected({ book }), 'book')).not.toThrow();
  expect(book).toEqual(before);
  expect(book.releases).toHaveLength(6);
});

for (const field of ['realization', 'realizationRevision', 'language', 'platform'] as const) {
  test(`release ${field} requires actual text or explicit null, not omitted or invalid metadata`, () => {
    for (const invalid of [undefined, 123, '']) {
      const book = unitBook();
      (book.releases[0] as unknown as Record<string, unknown>)[field] = invalid;
      expect(() => assertPublicDomainSelectedPremises(selected({ book }), 'book')).toThrow('strings or explicit nulls');
    }
  });
}

function borrowedBook() {
  const product = '76c5955006dbea2016e84465d8f3e79fdf4fc979', support = 'd2f04140fe615eadef0379a52c26291e6e083217';
  const run = 'book-current-site-20261020-r1', project = `rezics-qa-${run}`;
  const endpoints = { main: 'http://127.0.0.1:42963', account: 'http://127.0.0.1:42701' };
  const manifest = { ...selected({ book: unitBook() }), execution: {
    productBaseline: '69eac3ceeaf885be70205a70248bc951e9d81cc9', productRevision: product,
    frontendRevision: product, testRevision: 'a'.repeat(40), fixtureGeneration: 'recipes-build-mw0book-8b7d14',
    retainedCustody: { file: 'unit-custody', sha256: 'b'.repeat(64) },
  } } as PublicDomainCorpus & { execution: Record<string, unknown> };
  manifest.personas = { realm: id(80_000), space: id(80_001), zone: id(80_002), visibility: 'public',
    identities: Object.fromEntries(personaNames.filter(name => name !== 'visitor').map((name, index) =>
      [name, { email: `${name}@example.invalid`, password: `unit-${name}`, accountId: `unit-account-${name}`,
        actingSubject: id(80_010 + index) }])) as PublicDomainCorpus['personas']['identities'],
    auth: { accountOrigin: 'http://retained-account.invalid', clientId: 'unit-client', redirectUris: ['http://unit.invalid/callback'],
      scope: 'openid offline_access', mainClientId: 'unit-main', mainClientSecret: 'unit-secret', resource: 'https://main.rezics.test' },
  } as PublicDomainCorpus['personas'];
  const original = structuredClone(manifest);
  original.execution.testRevision = support;
  const model = { file: 'generated/model/manifest.json', sha256: 'c'.repeat(64) };
  const owner = { pid: 1234, startTicks: 'unit-start', script: '/unit/owner.ts' };
  const records = {
    producer: { productRevision: product, consumerSupportRevision: support, fixtureGeneration: manifest.execution.fixtureGeneration,
      releasedTo: 'G-2823', copy: { runId: run, project }, endpoints,
      artifacts: { publicDomainConsumer: { sha256: '767717d646390e440a2048eacd9b4b8d5d51afa43ad2f483399b2261866eb13c' },
        custody: { sha256: 'b'.repeat(64) }, stoppedBackup: { sha256: 'd'.repeat(64) } },
      runtime: { product, testRevision: support, runId: run, model }, compatibilityDigest: 'e'.repeat(64),
      bookNative: { work: manifest.book.work } },
    ready: { exit: 0, pid: owner.pid, productRevision: product, supportRevision: support, runId: run, project, ...endpoints },
    qualification: { exit: 0, productRevision: product, overlayRevision: support, project, ownerProcess: { ...owner }, model,
      compatibility: { digest: 'e'.repeat(64) }, migrations: { pending: [] as string[] }, native: {
        moduleVersion: '0.5.43', instanceId: '11d5871b-af7e-44e7-927b-667c943ed3e7', publicSearchWriteEpoch: '4',
        profilesSha256: 'd3b0d41321fbd5c38bce4b8fa8327d381fb8be0ba601f6922c839ea0146f406e' } },
    physical: { exit: 0, backupManifest: { sha256: 'd'.repeat(64), verified: true } },
    owner, corpus: original, personas: structuredClone(manifest.personas),
  };
  return { manifest, records, endpoints };
}

test('borrowed Book admits the exact retained copy with a separate executable test pin', () => {
  const { manifest, records, endpoints } = borrowedBook(), before = structuredClone({ manifest, records });
  expect(assertPublicDomainBorrowedBook(manifest, 'book', records)).toEqual(endpoints);
  expect({ manifest, records }).toEqual(before);
});

const borrowRefusals: Array<[string, (input: ReturnType<typeof borrowedBook>) => void]> = [
  ['product pin', input => { input.manifest.execution.productRevision = 'f'.repeat(40); }],
  ['support pin', input => { input.records.ready.supportRevision = 'f'.repeat(40); }],
  ['frontend pin', input => { input.manifest.execution.frontendRevision = 'f'.repeat(40); }],
  ['missing test pin', input => { delete input.manifest.execution.testRevision; }],
  ['wrong generation', input => { input.manifest.execution.fixtureGeneration = 'recipes-build-unbound-123456'; }],
  ['unqualified copy', input => { input.records.qualification.exit = 1; }],
  ['wrong run', input => { input.records.ready.runId = 'another-copy'; }],
  ['wrong Main', input => { input.records.ready.main = 'http://127.0.0.1:1'; }],
  ['wrong Account', input => { input.records.producer.endpoints.account = 'http://127.0.0.1:2'; }],
  ['stale owner', input => { input.records.owner.startTicks = 'reused-pid'; }],
  ['changed owner script', input => { input.records.owner.script = '/other/owner.ts'; }],
  ['unverified backup', input => { input.records.physical.backupManifest.verified = false; }],
  ['wrong backup', input => { input.records.physical.backupManifest.sha256 = 'f'.repeat(64); }],
  ['wrong native instance', input => { input.records.qualification.native.instanceId = 'another-instance'; }],
  ['wrong native profiles', input => { input.records.qualification.native.profilesSha256 = 'f'.repeat(64); }],
  ['wrong model', input => { input.records.qualification.model = { file: 'changed', sha256: 'f'.repeat(64) }; }],
  ['pending migration', input => { input.records.qualification.migrations.pending.push('unit-migration'); }],
  ['wrong original identity', input => { input.manifest.importedWorks[0] = work; }],
  ['changed Book', input => { input.manifest.book.chapters[0]!.selectedRevision = id(90_000); }],
  ['changed Account', input => { input.manifest.personas.identities.member.accountId = 'another-account'; }],
  ['changed acting subject', input => { input.manifest.personas.identities.moderator.actingSubject = id(90_001); }],
  ['swapped roles', input => {
    const identities = input.manifest.personas.identities;
    [identities.owner, identities.operator] = [identities.operator, identities.owner];
  }],
];
for (const [name, alter] of borrowRefusals) test(`borrowed Book refuses ${name} before attachment`, () => {
  const input = borrowedBook(); alter(input);
  expect(() => assertPublicDomainBorrowedBook(input.manifest, 'book', input.records)).toThrow('TEST PREMISE');
});
for (const selection of ['recipe', 'nutrition'] as const) test(`borrowed Book refuses ${selection} selection`, () => {
  const { manifest, records } = borrowedBook();
  expect(() => assertPublicDomainBorrowedBook(manifest, selection, records)).toThrow('Book-only');
});

for (const kind of ['missing', 'self-declared-ready', 'changed-attachment', 'changed-custodian-bytes'] as const)
  test(`borrowed Book refuses ${kind} evidence without a network request`, () => {
    const keys = ['REZICS_PUBLIC_DOMAIN_BORROWED_BOOK', 'REZICS_PUBLIC_DOMAIN_BORROWED_BOOK_SHA256'] as const;
    const previous = keys.map(key => Bun.env[key]);
    try {
      for (const key of keys) delete Bun.env[key];
      if (kind !== 'missing') {
        const evidence = pinJson({ invented: true });
        const pin = pinJson(kind === 'changed-custodian-bytes' ? { producer: {
          file: evidence.file, sha256: '67f2daa27512f56e20ddf44f6d60ac5fc64f1b55756ec912534a470dbd50621c',
        } } : { ready: true, main: 'http://127.0.0.1:42963' });
        Bun.env[keys[0]] = pin.file;
        Bun.env[keys[1]] = kind === 'changed-attachment' ? '0'.repeat(64) : pin.sha256;
      }
      expect(() => loadPublicDomainBorrowedBook(borrowedBook().manifest, 'book')).toThrow('TEST PREMISE');
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete Bun.env[key]; else Bun.env[key] = previous[index];
      });
    }
  });

// Exercise the existing OAuth and persona operations with transport-only doubles; no application or storage starts.
async function borrowTransport(failure?: 'account' | 'oauth' | 'attach' | 'cleanup',
  cleanup: Partial<Record<'refresh_token' | 'access_token' | 'sign-out', () => Response>> = {}) {
  const input = borrowedBook(), requests: Array<{ path: string; cookie: string | null; authorization: string | null;
    session: string | null; tokenType: string | null }> = [];
  let logins = 0, tokens = 0, bindings = 0;
  const previous = globalThis.fetch;
  const fake: typeof fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url)), path = parsed.pathname, headers = new Headers(init?.headers);
    const tokenType = init?.body instanceof URLSearchParams ? init.body.get('token_type_hint') : null;
    requests.push({ path, cookie: headers.get('cookie'), authorization: headers.get('authorization'), session: headers.get('x-session-key'), tokenType });
    if (path === '/api/auth/sign-in/email') {
      logins++;
      const { email } = JSON.parse(String(init?.body)) as { email: string };
      const identity = Object.values(input.manifest.personas.identities).find(person => person.email === email)!;
      return Response.json({ user: { id: failure === 'account' && logins === 3 ? 'wrong-account' : identity.accountId } },
        { headers: { 'set-cookie': `unit-fresh=${logins}; Path=/; HttpOnly` } });
    }
    if (path === '/api/auth/oauth2/authorize') return new Response(null,
      { status: 302, headers: { location: '/consent?oauth_query=unit' } });
    if (path === '/api/account/consent') return Response.json({ url: 'http://unit.invalid/callback?code=unit' });
    if (path === '/api/auth/oauth2/token') {
      tokens++;
      if (failure === 'oauth' && tokens === 3) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.unit-${tokens}`,
        refresh_token: `unit-refresh-${tokens}`, expires_in: 3600, scope: 'openid offline_access' });
    }
    if (path === '/v1/me/session-agent') {
      bindings++;
      const body = JSON.parse(String(init?.body)) as { actingSubject: string; expectedRevision: null };
      expect(body).toEqual({ actingSubject: input.manifest.personas.identities[personaNames[bindings]! as 'stranger'].actingSubject, expectedRevision: null });
      return Response.json({}, { status: failure === 'attach' && bindings === 3 ? 403 : 200 });
    }
    if (path === '/api/auth/sign-out' || path === '/api/auth/oauth2/revoke') {
      const response = cleanup[path.endsWith('sign-out') ? 'sign-out' : tokenType as 'refresh_token' | 'access_token'];
      return response ? response() : Response.json({}, { status: failure === 'cleanup' && path.endsWith('revoke') ? 503 : 200 });
    }
    if (path === '/unit-anonymous') return Response.json({ anonymous: true });
    throw new Error(`Unexpected borrowed transport operation: ${path}`);
  }, { preconnect: previous.preconnect });
  globalThis.fetch = fake;
  return { ...input, requests, restore: () => { globalThis.fetch = previous; } };
}

test('borrowed Book attaches five fresh normal OAuth sessions and closes only their auth handles', async () => {
  const input = await borrowTransport();
  try {
    const people = await attachPublicDomainBook(input.manifest, input.endpoints);
    expect(people.visitor.accountId).toBeNull(); expect(people.visitor.actingSubject).toBeNull();
    await people.visitor.main('GET', '/unit-anonymous');
    expect(input.requests.at(-1)).toMatchObject({ authorization: null, cookie: null });
    for (const name of personaNames.filter(name => name !== 'visitor'))
      expect([people[name].accountId, people[name].actingSubject]).toEqual([
        input.manifest.personas.identities[name].accountId, input.manifest.personas.identities[name].actingSubject]);
    const bindings = input.requests.filter(request => request.path === '/v1/me/session-agent');
    expect(bindings).toHaveLength(5); expect(new Set(bindings.map(request => request.session)).size).toBe(5);
    expect(bindings.every(request => request.authorization?.startsWith('Bearer '))).toBe(true);
    await people.close();
    expect(input.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(10);
    expect(input.requests.filter(request => request.path.endsWith('/sign-out')).map(request => request.cookie))
      .toEqual(Array.from({ length: 5 }, (_, index) => `unit-fresh=${index + 1}`));
    const count = input.requests.length; await people.close(); expect(input.requests).toHaveLength(count);
  } finally { input.restore(); }
});

for (const failure of ['account', 'oauth', 'attach'] as const) test(`borrowed Book failed ${failure} attach closes all acquired fresh handles`, async () => {
  const input = await borrowTransport(failure);
  try {
    await expect(attachPublicDomainBook(input.manifest, input.endpoints)).rejects.toThrow();
    expect(input.requests.filter(request => request.path.endsWith('/sign-out'))).toHaveLength(3);
    expect(input.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(failure === 'attach' ? 6 : 4);
    expect(input.requests.filter(request => request.path.endsWith('/sign-in/email'))).toHaveLength(3);
  } finally { input.restore(); }
});

test('borrowed Book cleanup failure is reported after every borrower handle gets sign-out', async () => {
  const input = await borrowTransport('cleanup');
  try {
    const people = await attachPublicDomainBook(input.manifest, input.endpoints);
    await expect(people.close()).rejects.toThrow('auth cleanup failed');
    expect(input.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(10);
    expect(input.requests.filter(request => request.path.endsWith('/sign-out'))).toHaveLength(5);
  } finally { input.restore(); }
});

function cleanupFailures(error: unknown): Array<Record<string, unknown>> {
  return error instanceof AggregateError ? error.errors.flatMap(cleanupFailures) : [error as Record<string, unknown>];
}

test('borrowed Book refresh refusal still revokes each access token and reports only safe status and OAuth error', async () => {
  const secret = 'unit-private-credential-must-not-leave-cleanup';
  const input = await borrowTransport(undefined, { refresh_token: () => Response.json({ error: 'invalid_client',
    error_description: secret, token: secret, cookie: secret }, { status: 401 }) });
  try {
    const people = await attachPublicDomainBook(input.manifest, input.endpoints);
    const error: unknown = await people.close().catch(cause => cause), failures = cleanupFailures(error);
    expect(failures).toHaveLength(5);
    expect(failures.map(failure => failure.persona)).toEqual(personaNames.filter(name => name !== 'visitor'));
    for (const failure of failures) {
      expect(failure).toMatchObject({ operation: 'revoke refresh_token', status: 401, oauthError: 'invalid_client', accountCode: null });
      expect(String(failure)).toContain('HTTP 401');
      expect(String(failure)).toContain('invalid_client');
      expect(String(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
    expect(input.requests.filter(request => request.tokenType === 'refresh_token')).toHaveLength(5);
    expect(input.requests.filter(request => request.tokenType === 'access_token')).toHaveLength(5);
    expect(input.requests.filter(request => request.path.endsWith('/sign-out'))).toHaveLength(5);
  } finally { input.restore(); }
});

test('borrowed Book sign-out refusal preserves both token failures for all five people', async () => {
  const input = await borrowTransport(undefined, {
    refresh_token: () => Response.json({ error: 'invalid_request' }, { status: 400 }),
    access_token: () => Response.json({ error: 'unsupported_token_type' }, { status: 400 }),
    'sign-out': () => Response.json({ code: 'INVALID_ORIGIN', message: 'unit-private-response' }, { status: 403 }),
  });
  try {
    const people = await attachPublicDomainBook(input.manifest, input.endpoints);
    const failures = cleanupFailures(await people.close().catch(cause => cause));
    expect(failures).toHaveLength(15);
    for (const name of personaNames.filter(name => name !== 'visitor'))
      expect(failures.filter(failure => failure.persona === name)).toMatchObject([
        { operation: 'revoke refresh_token', status: 400, oauthError: 'invalid_request', accountCode: null },
        { operation: 'revoke access_token', status: 400, oauthError: 'unsupported_token_type', accountCode: null },
        { operation: 'sign-out', status: 403, oauthError: null, accountCode: 'INVALID_ORIGIN' },
      ]);
    expect(JSON.stringify(failures)).not.toContain('unit-private-response');
  } finally { input.restore(); }
});

for (const response of ['json', 'text', 'transport'] as const)
  test(`borrowed Book ${response} cleanup failure redacts unknown response fields and retains the failed close`, async () => {
    const secret = 'unit-secret-cookie-or-token', input = await borrowTransport(undefined, { refresh_token: () => {
      if (response === 'transport') throw new Error(secret);
      return response === 'text' ? new Response(secret, { status: 502 })
        : Response.json({ error: secret, code: secret, error_description: secret }, { status: 403 });
    } });
    try {
      const people = await attachPublicDomainBook(input.manifest, input.endpoints);
      const [first, concurrent] = await Promise.all([people.close().catch(cause => cause), people.close().catch(cause => cause)]);
      expect(first).toBeInstanceOf(AggregateError);
      expect(concurrent).toBe(first);
      const failures = cleanupFailures(first);
      expect(failures).toHaveLength(5);
      for (const failure of failures) {
        expect(failure).toMatchObject({ operation: 'revoke refresh_token',
          status: response === 'transport' ? null : response === 'text' ? 502 : 403, oauthError: null, accountCode: null });
        expect(String(failure)).not.toContain(secret);
        expect(JSON.stringify(failure)).not.toContain(secret);
      }
      expect(input.requests.filter(request => request.path.endsWith('/revoke'))).toHaveLength(10);
      expect(input.requests.filter(request => request.path.endsWith('/sign-out'))).toHaveLength(5);
      const count = input.requests.length;
      expect(await people.close().catch(cause => cause)).toBe(first);
      expect(input.requests).toHaveLength(count);
    } finally { input.restore(); }
  });

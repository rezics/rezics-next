import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AuditCommandReceipt, AuditOriginals } from '../fixtures/audit-corpus-contract.ts';
import { assertPublicDomainNativeCreation, assertPublicDomainOriginalWorks, type PublicDomainSelectedCorpus,
  type PublicRecipe, type RealBook, type Measure } from '../fixtures/catalogue-public-domain.ts';
import { assertPublicDomainWorkAdmission, assertPublicDomainSelectedPremises } from '../support/catalogue-public-domain.ts';

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

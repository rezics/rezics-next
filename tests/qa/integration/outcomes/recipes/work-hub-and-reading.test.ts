import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import hub, { sourcedRecipePrerequisites } from '../../../../../scripts/qa/cases/outcomes/recipes/work-hub-and-reading.ts';
import { acting, fixtureAnswer, originalRecipe, short, type RecipeWork } from '../../../../../scripts/qa/cases/outcomes/recipes/read-a-recipe.ts';
import { launchRecipeSources } from '../../../../../scripts/load/launch-corpus.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaNames, personaSessions, type PersonaName, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let original: RecipeWork;
let imported: RecipeWork;
let observation: Observation;
let principalId: string;
let intakeRefusal: { status: number; body: string } | undefined;
const source = launchRecipeSources().find(recipe => recipe.pinId === 'boston-cookbook' && recipe.recipeId === 'quick-puff-paste')!;
const sourceUrl = 'https://www.gutenberg.org/ebooks/65061';
const author = 'Fannie Merritt Farmer';
const methods = source.methods.map(text => ({ '@type': 'HowToStep', text, inLanguage: source.language }));
// These sections are transcriber layout, not claims about headings in the book.
// Original source text, including indentation and physical lines, stays exact.
const retainedRecipe = {
  '@context': 'https://schema.org', '@type': 'Recipe', name: source.title, inLanguage: source.language,
  url: sourceUrl, author: { '@type': 'Person', name: author },
  isBasedOn: { url: sourceUrl, edition: '1910', sourceSha256: source.sourceSha256,
    recipeId: source.recipeId, ingredientLines: [23343, 23346], methodLines: [23348, 23353] },
  recipeIngredient: source.ingredients,
  recipeInstructions: [{ '@type': 'HowToSection', name: 'Transcriber layout', inLanguage: source.language,
    itemListElement: [methods[0], { '@type': 'HowToSection', name: 'Continuation',
      inLanguage: source.language, itemListElement: methods.slice(1) },
    { '@type': 'HowToSection', name: 'Empty annotation', inLanguage: source.language, itemListElement: [] }] }],
};
const bytes = Buffer.from(JSON.stringify(retainedRecipe));
const intake = {
  profile: 'source-manual-intake-v1', provider: 'gutenberg', namespace: 'recipe-extract',
  externalId: '65061/quick-puff-paste', sourceRevision: source.sourceSha256,
  mediaType: 'application/ld+json', retention: 'retained', rawBytesBase64: bytes.toString('base64'),
  coverage: { scope: 'complete-recipe', complete: true, omittedFields: [] },
  rightsEvidence: { basis: 'unknown', note: `Bounded pinned extract; requested basis public-domain; ${sourceUrl}; source-stated author ${author}. Retention is not clearance.` },
};
interface Observation {
  record: string; observation: string; provider: string; namespace: string; externalId: string;
  sourceRevision: string; byteDigest: string; byteLength: number; rawBytesBase64: string;
  rightsEvidence: { basis: string; note: string };
}
interface Occurrence {
  occurrence: string; parent: string; role: string; labels: Array<{ value: string; language: string }>;
  qualifier?: { originalText?: { value: string; language: string }; amount?: { numerator: number; denominator: number };
    instructionText?: { value: string; language: string } };
}
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function grants() {
  return fixtureAnswer<{ authorityEpoch: string; items: Array<{ id: string; generation: string; permission: string; active: boolean;
    issuerSubject: string; recipient: { principalId?: string } }> }>(sessions.operator.main('GET',
    `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(sessions.operator.actingSubject!)}`));
}
async function mandate(permission: string, scopeId?: string) {
  const listing = await grants();
  const response = await sessions.operator.main('POST',
    '/v1/access/grant-changes', { profile: 'platform-grant-change-v1', action: 'create',
      issuerSubject: sessions.operator.actingSubject, expectedAuthorityEpoch: listing.authorityEpoch,
      grantId: randomUUID(), permission, ...(scopeId ? { scopeId } : {}), recipient: { principalId },
      validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  const raw = await response.text();
  if (response.status !== 200) console.info('Sourced Recipe mandate setup refusal', { permission, scopeId, status: response.status, body: raw });
  expect(response.status, `SETUP mandate ${permission} at ${scopeId ?? 'platform:access'}: ${raw}; operation not reached`).toBe(200);
  return JSON.parse(raw) as { grant: { id: string; generation: string } };
}
async function revoke(grant: { id: string; generation: string }) {
  await answer(sessions.operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', action: 'revoke', issuerSubject: sessions.operator.actingSubject,
    expectedAuthorityEpoch: (await grants()).authorityEpoch, grantId: grant.id,
    expectedObjectGeneration: grant.generation,
  }));
}
function publication(name: PersonaName) {
  return { profile: 'work-structure-publication-v1', operation: 'publish', work: imported.work,
    actingSubject: sessions[name].actingSubject ?? sessions.operator.actingSubject, expectedWorkHead: imported.workRevision,
    expectedMainVersion: imported.mainVersion, structure: imported.structure,
    expectedStructureHead: imported.revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: observation.observation };
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  original = await originalRecipe(sessions.owner, 'Original sauce hub');
  const listing = await grants();
  principalId = listing.items.find(item => item.permission === 'platform:grant' && item.active
    && item.issuerSubject === sessions.operator.actingSubject)!.recipient.principalId!;
  // Deployment bootstrap includes catalogue creation. Remove its recorded
  // grant through Access before proving status alone supplies no import power.
  for (const grant of listing.items.filter(item => item.active && item.permission === 'platform:resource:work.create'))
    await revoke(grant);
  await mandate('platform:use:catalogue-import');
  // A platform-admin designation and exposure alone do not grant import.
  await answer(sessions.operator.main('POST', '/v1/sources/intakes', intake), 403);
  await mandate('platform:resource:work.create', 'work:create:root');
  const desired = await sessions.operator.main('POST', '/v1/sources/intakes', { ...intake,
    rightsEvidence: { ...intake.rightsEvidence, basis: 'public-domain' } });
  const raw = await desired.text();
  if (desired.status === 201) observation = (JSON.parse(raw) as { observation: Observation }).observation;
  else {
    intakeRefusal = { status: desired.status, body: raw };
    console.info('Sourced Recipe intake setup refusal', intakeRefusal);
    // Diagnostic retention only: every publication cell still requires the
    // accepted public-domain intake. No private-file import or original label.
    observation = (await fixtureAnswer<{ observation: Observation }>(sessions.operator.main('POST', '/v1/sources/intakes', intake), 201)).observation;
  }
  const candidates = await fixtureAnswer<{ candidateReceipt: string }>(sessions.operator.main('POST', '/v1/catalogue/candidates', {
    profile: 'catalogue-candidates-v1', originalTitle: { value: source.title, language: source.language },
    aliases: [], romanizations: [], creators: [author], dates: [1910], identifiers: [],
  }));
  // Catalogue authoring deliberately creates no importer-as-author credit.
  const work = await fixtureAnswer<{ work: string; workRevision: string; mainVersion: string }>(sessions.operator.main('POST',
    '/v1/works', { profile: 'metadata-only-v1', title: source.title, language: source.language,
      semanticTypes: ['https://schema.org/Recipe'], authoring: 'catalogue', grain: 'new-creative-scope',
      candidateReceipt: candidates.candidateReceipt, actingSubject: sessions.operator.actingSubject }), 201);
  const composition = await fixtureAnswer<{ structure: string; revision: string }>(sessions.operator.main('POST',
    '/v1/compositions', { profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
      actingSubject: sessions.operator.actingSubject }), 201);
  imported = { ...work, ...composition, ingredientTexts: [], occurrenceIds: [] };
}, 180_000);
afterAll(async () => { await sessions?.close(); });

async function readOriginalHub(name: PersonaName) {
  const person = sessions[name], root = `/v1/works/${short(original.work)}`;
  const header = await answer<{ publicationState: string; links: { credits: string } }>(person.main('GET', `${root}?${acting(person)}`));
  expect(header.publicationState).toBe('published');
  expect(header.links.credits).toContain('/credits');
  const credits = await answer<{ items: Array<{ role: string; agent: string | null }> }>(person.main('GET', `${root}/credits?${acting(person)}`));
  expect(credits.items).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'author', agent: sessions.owner.actingSubject })]));
  const recipe = await answer<{ revision: string; occurrences: unknown[]; ingredients: Array<{ originalText: string }> }>(person.main('GET',
    `/v1/recipes/works/${short(original.work)}?${acting(person)}`));
  expect(recipe.revision).toBe(original.revision);
  expect(recipe.ingredients.map(item => item.originalText)).toEqual(original.ingredientTexts);
  expect(recipe.occurrences).toHaveLength(6);
}
for (const name of personaNames) {
  test(`original Recipe hub / ${name}: published structure and native author`, () => readOriginalHub(name));
  if (name !== 'operator') test(`Source / ${name}: refuses intake and retained observation without platform mandate`, async () => {
    // Use a valid current body so schema rejection cannot stand in for denial.
    const response = await sessions[name].main('POST', '/v1/sources/intakes', intake);
    expect(response.status).toBe(name === 'visitor' ? 401 : 403);
    const retained = await sessions[name].main('GET', `/v1/sources/observations/${short(observation.observation)}`);
    expect(retained.status).toBe(name === 'visitor' ? 401 : 403);
  });
}
test('Source observation / operator: retains exact bounded source identity, link, author and evidence', async () => {
  const read = await answer<Observation>(sessions.operator.main('GET', `/v1/sources/observations/${short(observation.observation)}`));
  expect(read).toMatchObject({ record: observation.record, observation: observation.observation,
    provider: intake.provider, namespace: intake.namespace, externalId: intake.externalId,
    sourceRevision: source.sourceSha256, byteDigest: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength, rawBytesBase64: intake.rawBytesBase64,
    rightsEvidence: { basis: intakeRefusal ? 'unknown' : 'public-domain', note: intake.rightsEvidence.note } });
  expect(JSON.parse(Buffer.from(read.rawBytesBase64, 'base64').toString())).toEqual(retainedRecipe);
});
test.failing('Source intake / operator: accepts public-domain evidence under the import mandate', () => {
  expect(intakeRefusal, `SETUP intake: ${sourcedRecipePrerequisites.intake}; ${JSON.stringify(intakeRefusal)}`).toBeUndefined();
});
let rightsSetup: Promise<void> | undefined;
function assessedUse() {
  return rightsSetup ??= (async () => {
    const grant = await mandate('platform:resource:rights.assess', 'rights:assess');
    try {
      const material = { scopeKind: 'source_record', provider: intake.provider, namespace: intake.namespace,
        sourceRecordId: short(observation.record), contentVariantId: null, mediaAsset: null, component: 'recipe' };
      const use = { family: 'data_rights', useKind: 'redistribution', useScope: 'rezics:public-structure' };
      const response = await sessions.operator.main('POST', '/v1/rights/use-evaluations', {
        profile: 'rights-use-evaluation-v1', actingSubject: sessions.operator.actingSubject,
        material, ...use,
      });
      const raw = await response.text();
      console.info('Sourced Recipe Rights evaluation', { status: response.status, body: raw });
      expect(response.status, `SETUP Rights: ${sourcedRecipePrerequisites.rights}; ${response.status}: ${raw}`).toBe(200);
      // No fixture-wide clearance is asserted: this exact use starts unassessed.
      expect(JSON.parse(raw)).toMatchObject({ status: 'unassessed' });
      const key = randomUUID();
      await answer(sessions.operator.main('POST', '/v1/rights/use-assessments', {
        profile: 'rights-use-assessment-v1', actingSubject: sessions.operator.actingSubject, material, ...use,
        expressionKind: 'expression', basis: 'public_domain', outcome: 'supported',
        licenseInstrument: null, exceptionKind: null, rationale: 'Accepted bounded pinned Recipe extract only; no corpus clearance.',
        extent: { recipeId: source.recipeId, ingredientLines: [23343, 23346], methodLines: [23348, 23353] },
        evidence: { observation: observation.observation, byteDigest: observation.byteDigest, sourceUrl },
        obligations: [], expectedAssessment: null, idempotencyKey: key,
      }, key), 201);
      const evaluated = await answer<{ status: string; assessment: { basis: string; outcome: string } }>(sessions.operator.main('POST',
        '/v1/rights/use-evaluations', { profile: 'rights-use-evaluation-v1', actingSubject: sessions.operator.actingSubject, material, ...use }));
      expect(evaluated).toMatchObject({ status: 'assessed', assessment: { basis: 'public_domain', outcome: 'supported' } });
    } finally { await revoke(grant.grant); }
  })();
}
test.failing('Rights / operator: provisions assessment mandate and evaluates only the bounded source use', () => assessedUse());

let supported: Promise<void> | undefined;
function supportedStructure() {
  return supported ??= (async () => {
    const result = await answer<{ revision: string; sourceObservation: string; supports: string[];
      unboundSourceKeys: string[] }>(sessions.operator.main('POST', `/v1/recipes/${short(imported.structure)}/imports`, {
      expectedHead: imported.revision, actingSubject: sessions.operator.actingSubject,
      sourceObservation: observation.observation,
    }));
    imported.revision = result.revision;
    expect(result.sourceObservation).toBe(observation.observation);
    expect(result.unboundSourceKeys).toEqual([]);
    expect(result.supports).toHaveLength(source.ingredients.length + source.methods.length);
    const occurrenceIds: string[] = [];
    for (const support of result.supports) {
      const binding = await answer<{ sourceRecord: string; context: string; occurrence: string; target: string }>(
        sessions.operator.main('GET', `/v1/sources/field-supports/${short(support)}`));
      expect(binding).toMatchObject({ sourceRecord: observation.record, context: imported.structure, target: imported.work });
      occurrenceIds.push(binding.occurrence);
    }
    expect(new Set(occurrenceIds).size).toBe(result.supports.length);
  })();
}
async function structureAndText(name: PersonaName, revision: string, checkNesting = true) {
  const person = sessions[name];
  const selected = await answer<{ revision: string; occurrences: Occurrence[];
    ingredients: Array<{ originalText: string; amount?: { numerator: number; denominator: number } }> }>(person.main('GET',
    `/v1/recipes/works/${short(imported.work)}?${acting(person)}`));
  expect(selected.revision).toBe(revision);
  expect(selected.ingredients.map(item => item.originalText)).toEqual(source.ingredients);
  expect(selected.ingredients.map(item => item.amount ?? null)).toEqual([
    { numerator: 1, denominator: 1 }, { numerator: 1, denominator: 1 }, null, { numerator: 7, denominator: 8 },
  ]);
  const groups = selected.occurrences.filter(item => item.role === 'group');
  expect(groups.map(item => item.labels)).toEqual(['Transcriber layout', 'Continuation', 'Empty annotation']
    .map(value => [{ value, language: source.language }]));
  expect(selected.occurrences.map(item => item.role)).toEqual([
    'group', 'step', 'group', ...source.methods.slice(1).map(() => 'step'), 'group', ...source.ingredients.map(() => 'ingredient'),
  ]);
  if (checkNesting) expect(groups.map(item => item.parent)).toEqual([imported.structure, groups[0]!.occurrence, groups[0]!.occurrence]);
  expect(selected.occurrences.filter(item => item.parent === groups[2]!.occurrence)).toEqual([]);
  const steps = selected.occurrences.filter(item => item.role === 'step');
  expect(steps.map(item => item.qualifier?.instructionText)).toEqual(source.methods.map(value => ({ value, language: source.language })));
  expect(steps.map(item => item.parent)).toEqual([groups[0]!.occurrence, ...source.methods.slice(1).map(() => groups[1]!.occurrence)]);
  expect(selected.occurrences.filter(item => item.role === 'ingredient').map(item => item.qualifier?.originalText))
    .toEqual(source.ingredients.map(value => ({ value, language: source.language })));
}
test('Source-backed Structure / operator: binds every exact line; preserves rational quantities, language, order and empty groups', async () => {
  await supportedStructure();
  // Diagnostic proof excludes the separately pending nested parent invariant.
  await structureAndText('operator', imported.revision, false);
  const credits = await answer<{ items: Array<{ role: string; agent: string | null }> }>(sessions.operator.main('GET',
    `/v1/works/${short(imported.work)}/credits?${acting(sessions.operator)}`));
  expect(credits.items.some(item => item.role === 'author' && item.agent === sessions.operator.actingSubject)).toBe(false);
});
test.failing('Source-backed Structure / operator: preserves nested section parents as well as empty groups', async () => {
  await supportedStructure();
  await structureAndText('operator', imported.revision);
});
for (const name of personaNames.filter(name => name !== 'operator')) {
  test.failing(`Sourced publication / ${name}: refuses caller without the corresponding platform mandate`, async () => {
    await supportedStructure();
    // Pending separately: current schema rejects before Access can decide.
    await answer(sessions[name].main('POST', '/v1/work-publications', publication(name)), name === 'visitor' ? 401 : 403);
  });
}
test.failing('Sourced publication / operator: platform status and import mandate alone cannot publish', async () => {
  await supportedStructure();
  await answer(sessions.operator.main('POST', '/v1/work-publications', publication('operator')), 403);
});
test.failing('Sourced publication / operator: a mandate for another Work cannot publish this source', async () => {
  await supportedStructure();
  const grant = await mandate('platform:resource:work.publish', `work:publish:${original.work}`);
  try { await answer(sessions.operator.main('POST', '/v1/work-publications', publication('operator')), 403); }
  finally { await revoke(grant.grant); }
});
test.failing('Sourced publication setup / operator: provisions an exact Work publication mandate', async () => {
  const grant = await mandate('platform:resource:work.publish', `work:publish:${imported.work}`);
  await revoke(grant.grant);
});
let published: Promise<string> | undefined;
function sourcePublication() {
  return published ??= (async () => {
    await supportedStructure();
    expect(intakeRefusal, `SETUP intake: ${JSON.stringify(intakeRefusal)}; reader delivery not reached`).toBeUndefined();
    await structureAndText('operator', imported.revision);
    await assessedUse();
    const grant = await mandate('platform:resource:work.publish', `work:publish:${imported.work}`);
    try {
      const response = await sessions.operator.main('POST', '/v1/work-publications', publication('operator'));
      const raw = await response.text();
      console.info('Sourced Recipe publication setup', { status: response.status, body: raw });
      expect(response.status, `SETUP publication: ${sourcedRecipePrerequisites.publication}; ${response.status}: ${raw}; reader delivery not reached`).toBe(201);
      expect(observation.rightsEvidence.basis, 'SETUP requires accepted public-domain Source evidence').toBe('public-domain');
      return imported.revision;
    } finally { await revoke(grant.grant); }
  })();
}
async function readSourcedHub(name: PersonaName) {
  const revision = await sourcePublication();
  await structureAndText(name, revision);
  const person = sessions[name], root = `/v1/works/${short(imported.work)}`;
  const header = await answer<{ publicationState: string; rights: unknown }>(person.main('GET', `${root}?${acting(person)}`));
  expect(header.publicationState).toBe('published');
  expect(header.rights).toMatchObject({ basis: 'public-domain', source: { record: observation.record,
    observation: observation.observation, provider: 'gutenberg', externalId: intake.externalId, url: sourceUrl } });
  const credits = await answer<{ items: Array<{ role: string; agent?: string | null; displayName: string | null }> }>(
    person.main('GET', `${root}/credits?${acting(person)}`));
  expect(credits.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'author', displayName: author, agent: null }),
    expect.objectContaining({ role: 'transcriber', agent: sessions.operator.actingSubject }),
  ]));
  expect(credits.items.some(item => item.role === 'author' && item.agent === sessions.operator.actingSubject)).toBe(false);
}
outcomeTest(hub, 'visitor', () => readSourcedHub('visitor'));
outcomeTest(hub, 'stranger', () => readSourcedHub('stranger'));
outcomeTest(hub, 'member', () => readSourcedHub('member'));
outcomeTest(hub, 'owner', () => readSourcedHub('owner'));
outcomeTest(hub, 'moderator', () => readSourcedHub('moderator'));
outcomeTest(hub, 'operator', () => readSourcedHub('operator'));

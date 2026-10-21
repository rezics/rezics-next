import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { prepareInstructionAdoptions } from '../src/modules/work/instruction-adoption.ts';
import { PublicationUnavailable } from '../src/modules/contribution/publish.ts';
import { prepareSourcedStructurePublication } from '../src/modules/work/sourced-structure-publication.ts';
import type { WorkStructurePublicationInput } from '../src/modules/work/structured-publication.ts';

const id = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const input = { work: id('1'), structure: id('2'), expectedStructureHead: id('3'), actingSubject: id('4') };
const principal = { issuer: 'https://accounts.example', subject: 'author' };
const revision = '00000000-0000-4000-8000-000000000005';

function dependencies(adopted: boolean) {
  let inventoryReads = 0;
  const work = { environment: { fuseki: { query: async (query: string) => {
    if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [{
      component: { value: id('6') }, profile: { value: 'https://rezics.com/vocab/RecipeComposition' },
      head: { value: input.expectedStructureHead }, generation: { value: id('12') },
      count: { value: adopted ? '1' : '0' }, manifest: { value: `urn:rezics:sha256:${'a'.repeat(64)}` },
    }] } };
    if (query.includes('SELECT ?owner')) return { results: { bindings: [{ owner: { value: input.work } }] } };
    if (query.includes('SELECT ?occurrence ?target ?selector')) {
      inventoryReads++;
      return { results: { bindings: adopted ? [{ occurrence: { value: id('7') }, target: { value: id('8') },
        selector: { value: JSON.stringify({ grain: 'content', revision, variantId: `urn:rezics:variant:${revision}` }) },
      }] : [] } };
    }
    throw new Error(`Unexpected publication dependency query: ${query}`);
  } } } } as unknown as MainWorkDependencies;
  return { work, inventoryReads: () => inventoryReads };
}

test('an empty Recipe publication completes dependency admission with vocabulary instruction roles', async () => {
  const fixture = dependencies(false);
  expect(await prepareInstructionAdoptions(fixture.work, input, 'publication', principal)).toEqual([]);
  expect(fixture.inventoryReads()).toBe(1);
});

test('Recipe publication still requires custody for every selected instruction dependency', async () => {
  const fixture = dependencies(true);
  await expect(prepareInstructionAdoptions(fixture.work, input, 'publication', principal))
    .rejects.toBeInstanceOf(PublicationUnavailable);
  expect(fixture.inventoryReads()).toBe(1);
});

test.each(['missing-bytes', 'incomplete', 'wrong-record', 'native-only'] as const)(
  'explicit retained-derived publication keeps its stronger %s correspondence refusal', async problem => {
    const fixture = dependencies(false);
    let rightsReads = 0;
    let intakeReads = 0;
    const observation = { observation: id('9'), record: id('10'), provider: 'recipe-fixture', externalId: 'recipe',
      rightsEvidence: { basis: 'public-domain' }, retention: 'retained', mediaType: 'application/ld+json',
      coverage: { complete: problem !== 'incomplete', omittedFields: [], scope: 'complete-recipe' },
      rawBytesBase64: problem === 'missing-bytes' ? null : Buffer.from(JSON.stringify({
        url: 'https://example.test/recipe', author: { name: 'Recipe author' }, recipeIngredient: ['1 cup rice'],
      })).toString('base64') };
    const deps = { ...fixture.work, access: { activePrincipalId: async () => id('4') },
      sourceIntake: { read: async () => { intakeReads++; return problem === 'wrong-record'
        ? { ...observation, observation: id('11') } : observation; } },
      rights: { store: { structuredPublicationRights: async () => { rightsReads++; return { allowed: true, heads: [] }; } } },
    } as unknown as MainWorkDependencies;
    const retained: WorkStructurePublicationInput = { profile: 'work-structure-publication-v1', operation: 'publish',
      ...input, expectedWorkHead: id('7'), expectedMainVersion: id('6'), expectedPublicationHead: null,
      disclosure: 'public', rightsBasis: 'public-domain', sourceObservation: observation.observation };
    await expect(prepareSourcedStructurePublication(deps, retained, principal)).rejects.toBeInstanceOf(PublicationUnavailable);
    expect(intakeReads).toBe(1);
    expect(rightsReads).toBe(0);
  });

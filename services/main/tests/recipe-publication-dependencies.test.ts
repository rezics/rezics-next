import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { prepareInstructionAdoptions } from '../src/modules/work/instruction-adoption.ts';
import { PublicationUnavailable } from '../src/modules/contribution/publish.ts';

const id = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const input = { work: id('1'), structure: id('2'), expectedStructureHead: id('3'), actingSubject: id('4') };
const principal = { issuer: 'https://accounts.example', subject: 'author' };
const revision = '00000000-0000-4000-8000-000000000005';

function dependencies(adopted: boolean) {
  let inventoryReads = 0;
  const work = { environment: { fuseki: { query: async (query: string) => {
    if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [{
      component: { value: id('6') }, profile: { value: 'https://rezics.com/vocab/RecipeComposition' },
      head: { value: input.expectedStructureHead }, generation: { value: 'urn:rezics:generation:recipe' },
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

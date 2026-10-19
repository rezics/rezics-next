import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverStructureProfiles, structureProfileFor, workPublicationProfileFor } from '../src/modules/structure/profiles.ts';
import { readCompositionHeader } from '../src/modules/structure/graph.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const temporary: string[] = [];
afterAll(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function directory(prefix: string): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, `.temp/${prefix}-`));
  temporary.push(path);
  return path;
}

function declaration(id: string, workPublication: boolean, componentType = 'https://rezics.com/vocab/MainVersion') {
  return `export const structureProfiles = [{
    id: '${id}', graphProfile: 'https://rezics.com/vocab/${id}',
    ownerType: 'https://schema.org/CreativeWork', componentType: '${componentType}',
    componentPredicate: 'https://rezics.com/vocab/mainVersion',
    ${workPublication ? 'workPublication: true,' : ''}
    editScopePrefix: 'work:edit:', editPermission: 'work:edit',
    editAction: 'work.edit', receiptFamily: 'edit-metadata-work',
    roles: ['section', 'entry'], containerRoles: ['section'], targetRoles: [],
    qualifiers: { entry: { type: 'fields', required: true, fieldId: 'entry-note', textFields: ['note'] } }
  }];`;
}

test('only reviewed MainVersion Work profiles resolve as public sources, with generic discovery', async () => {
  expect(workPublicationProfileFor('recipe-composition')).toBe(structureProfileFor('recipe-composition'));
  expect(structureProfileFor('recipe-composition').workPublication).toBe(true);
  expect(structureProfileFor('work-composition').workPublication).toBeUndefined();
  expect(structureProfileFor('book-composition').workPublication).toBeUndefined();
  expect(() => workPublicationProfileFor('work-composition')).toThrow('not reviewed for Work publication');
  expect(() => workPublicationProfileFor('book-composition')).toThrow('not reviewed for Work publication');

  const rootPath = directory('structured-publication-profile');
  const testOwner = join(rootPath, 'test-owner');
  mkdirSync(testOwner, { recursive: true });
  writeFileSync(join(testOwner, 'structure-profile.ts'), declaration('test-work-source', true));
  const profiles = await discoverStructureProfiles(rootPath);
  const generic = profiles.get('test-work-source')!;
  expect(workPublicationProfileFor(generic)).toBe(generic);
  expect(generic.ownerType).toBe('https://schema.org/CreativeWork');
  expect(generic.componentType).toBe('https://rezics.com/vocab/MainVersion');
  expect(generic.qualifiers?.entry).toEqual({
    type: 'fields', required: true, fieldId: 'entry-note', textFields: ['note'],
  });

  const badRoot = directory('structured-publication-invalid-profile');
  const badOwner = join(badRoot, 'bad-owner');
  mkdirSync(badOwner, { recursive: true });
  writeFileSync(join(badOwner, 'structure-profile.ts'), declaration('test-bad-source', true,
    'https://schema.org/Thing'));
  await expect(discoverStructureProfiles(badRoot)).rejects.toThrow('Duplicate or invalid Structure profile');
});

test('composition source evidence joins the selected generation to its exact revision', async () => {
  const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const owner = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const component = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
  const generation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
  const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000005';
  const calls: string[] = [];
  const env = { fuseki: { query: async (query: string) => {
    calls.push(query);
    if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [{
      component: { value: component }, profile: { value: 'https://rezics.com/vocab/RecipeComposition' },
      head: { value: revision }, generation: { value: generation },
      count: { value: '2' }, manifest: { value: `urn:rezics:sha256:${'c'.repeat(64)}` },
    }] } };
    return { results: { bindings: [{ owner: { value: owner } }] } };
  } } } as unknown as WorkActivationEnvironment;

  const header = await readCompositionHeader(env, structure);
  expect(header).toMatchObject({ owner, component, generation, head: revision, profile: 'recipe-composition' });
  expect(calls[0]).toMatch(/GRAPH <[^>]+> \{ \?head a rv:StructureRevision ;\s*rv:component <[^>]+> ; rv:generation \?generation ; rv:manifest \?manifest/);
  expect(header?.manifest).toBe(`urn:rezics:sha256:${'c'.repeat(64)}`);

  const unavailableClient = { fuseki: { query: async () => ({ results: { bindings: [] } }) } };
  const unavailable = unavailableClient as unknown as WorkActivationEnvironment;
  await expect(readCompositionHeader(unavailable, structure)).resolves.toBeNull();
});

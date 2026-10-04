import { expect, test } from 'bun:test';
import { buildArtifacts } from '../compiler/generate.ts';
import {
  compileTypes,
  typeBases,
  typeFrameDimensions,
  type TypeRegistryDefinition,
} from '../compiler/type.ts';
import { typesV1 } from '../definitions/types-v1.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';

const repo = new URL('../..', import.meta.url).pathname;
const compile = (definition: TypeRegistryDefinition = typesV1) =>
  compileTypes(definition, workKindV2Profile, workTypeV2Profile);
const rv = (name: string) => `https://rezics.com/vocab/${name}`;

test('frame dimensions are declared by exactly the descriptive types that can be a frame', () => {
  const dimensions = Object.fromEntries(
    compile()
      .filter((entry) => 'frameDimension' in entry)
      .map((entry) => [entry.type, (entry as { frameDimension: string }).frameDimension]),
  );
  expect(dimensions).toEqual({
    'https://schema.org/Event': 'event',
    [rv('NarrativeContinuity')]: 'continuity',
  });
  // A unit or a held title is a Resource but never a frame coordinate.
  for (const type of ['GameUnit', 'Title']) {
    const entry = compile().find((candidate) => candidate.type === rv(type))!;
    expect(entry.base).toBe('resource');
    expect(entry).not.toHaveProperty('frameDimension');
  }
  expect(typeFrameDimensions).toEqual(['continuity', 'event']);
});

test('the projection base has one structural default and no descriptive type declares a dimension elsewhere', () => {
  expect(typeBases).toContain('projection');
  const entries = compile();
  const projections = entries.filter((entry) => entry.base === 'projection');
  expect(projections.map((entry) => [entry.type, entry.default])).toEqual([[rv('Projection'), true]]);
  // Realms, Spaces, Contexts and Agents have no dimension, so they can never be frames.
  for (const type of ['Realm', 'Zone', 'Agent', 'Collection', 'Character', 'Role', 'Release']) {
    expect(entries.find((entry) => entry.type === rv(type))).not.toHaveProperty('frameDimension');
  }
  for (const entry of entries.filter((entry) => 'frameDimension' in entry)) {
    expect(entry.base).toBe('resource');
  }
});

test('the compiler rejects a dimension on a structural or work type and an unknown dimension', () => {
  const withDimension = (type: keyof typeof typesV1.types, frameDimension: unknown) =>
    ({
      ...typesV1,
      types: {
        ...typesV1.types,
        [type]: { ...typesV1.types[type], frameDimension },
      },
    }) as unknown as TypeRegistryDefinition;
  expect(() => compile(withDimension('schema:Book', 'continuity'))).toThrow('Invalid Type metadata');
  expect(() => compile(withDimension('rv:Release', 'event'))).toThrow('Invalid Type metadata');
  expect(() => compile(withDimension('rv:Projection', 'event'))).toThrow('Invalid Type metadata');
  // Structural bases own the work, realization, release and position dimensions in code.
  expect(() => compile(withDimension('rv:Character', 'work'))).toThrow('Invalid Type metadata');
  expect(() => compile(withDimension('rv:Character', 'position'))).toThrow('Invalid Type metadata');
  expect(() => compile(withDimension('rv:Character', 'continuity'))).not.toThrow();
});

test('the generated registry carries each frame dimension and the projection base', () => {
  const generated = buildArtifacts(repo).get('packages/model/src/generated/types.ts')!;
  expect(generated).toContain('export const typeFrameDimensions = ["continuity","event"] as const;');
  expect(generated).toContain('"base": "projection"');
  expect(generated).toContain('"frameDimension": "continuity"');
  expect(generated).toContain('"frameDimension": "event"');
});

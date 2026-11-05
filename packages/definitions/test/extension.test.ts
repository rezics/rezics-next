import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import {
  applyExtension,
  checkExtensionUpdate,
  EXTENSION_FORMAT,
  extensionDigest,
  termContext,
  termPrefix,
  validateExtension,
  type Extension,
  type TermDefinition,
} from '../src/extension.ts';
import { validateRelease } from '../src/index.ts';

const context = '0192e5aa-7c1d-8f3a-8c2b-4d5e6f708192';
const prefix = termPrefix(context);
const rival = `${prefix}:rivalOf`;
const mentor = `${prefix}:mentorOf`;
const student = `${prefix}:studentOf`;
const term = (overrides: Partial<TermDefinition> = {}): TermDefinition => ({
  description: { en: 'Two characters who compete.' },
  labels: { en: 'rival of' },
  domain: ['schema:Person'],
  targets: ['schema:Person'],
  multivalued: true,
  qualifiers: ['schema:position'],
  relation: { group: 'world', symmetric: true },
  ...overrides,
});
const extension = (terms: Record<string, TermDefinition>): Extension => ({
  format: EXTENSION_FORMAT,
  context,
  terms,
});
const valid = extension({
  [rival]: term(),
  [mentor]: term({
    labels: { en: 'mentor of' },
    relation: { group: 'association', inverse: student, inverseLabels: { en: 'student of' }, acyclic: true },
  }),
});
const check = (value: unknown) => validateExtension(value, bundledRelease, { context });

test('a valid extension adds relation properties that validate as a release', () => {
  expect(check(valid)).toEqual([]);
  const release = applyExtension(bundledRelease, valid);
  expect(validateRelease(release)).toEqual([]);
  expect(release.properties[mentor]!.iri).toBe(`https://rezics.com/contexts/${context}/terms/mentorOf`);
  expect(release.properties[mentor]!.relation).toEqual({
    group: 'association',
    inverse: student,
    inverseLabels: { en: 'student of' },
    acyclic: true,
  });
  expect(release.types['schema:Person']!.properties).toContain(rival);
  expect(bundledRelease.types['schema:Person']!.properties).not.toContain(rival);
  expect(termContext(rival)).toBe(context);
  expect(extensionDigest(valid)).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test('a term without a meaning, domain or range is refused with the field named', () => {
  const bare = extension({
    [rival]: { ...term(), description: undefined, domain: undefined, targets: undefined } as never,
  });
  expect(check(JSON.parse(JSON.stringify(bare)))).toEqual([
    { pointer: `/terms/${rival}/description`, code: 'required' },
    { pointer: `/terms/${rival}/domain`, code: 'required' },
    { pointer: `/terms/${rival}/targets`, code: 'required' },
  ]);
  expect(check(extension({ [rival]: term({ domain: [] }) }))).toEqual([
    { pointer: `/terms/${rival}/domain`, code: 'required' },
  ]);
  expect(check(extension({ [rival]: term({ description: { ja: '対立' } }) }))).toEqual([
    { pointer: `/terms/${rival}/description/en`, code: 'required' },
  ]);
});

test('terms stay within their Context, the release vocabulary and the limit', () => {
  const other = termPrefix('0192e5aa-7c1d-8f3a-8c2b-4d5e6f708193');
  expect(check(extension({ [`${other}:rivalOf`]: term() }))).toEqual([
    { pointer: `/terms/${other}:rivalOf`, code: 'invalid_format' },
  ]);
  expect(check(extension({ [rival]: term({ domain: ['schema:Nothing'] }) }))).toEqual([
    { pointer: `/terms/${rival}/domain/0`, code: 'invalid_format' },
  ]);
  expect(check(extension({ [rival]: term({ qualifiers: ['schema:url'] }) }))).toEqual([
    { pointer: `/terms/${rival}/qualifiers/0`, code: 'invalid_format' },
  ]);
  expect(check(extension({ [rival]: term({ relation: { group: 'credit' as never, symmetric: true } }) }))).toEqual([
    { pointer: `/terms/${rival}/relation/group`, code: 'invalid_format' },
  ]);
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`${prefix}:term${index}`, term()]));
  expect(check(extension(many))).toEqual([{ pointer: '/terms', code: 'out_of_range' }]);
});

test('a term keeps its meaning across extensions', () => {
  const relabelled = extension({
    ...valid.terms,
    [rival]: term({ labels: { en: 'rival', ja: 'ライバル' } }),
    [`${prefix}:friendOf`]: term({ labels: { en: 'friend of' } }),
  });
  expect(checkExtensionUpdate(valid, relabelled)).toEqual([]);
  const deprecated = extension({
    ...relabelled.terms,
    [rival]: { ...relabelled.terms[rival]!, deprecated: { replacedBy: `${prefix}:friendOf` } },
  });
  expect(check(deprecated)).toEqual([]);
  expect(checkExtensionUpdate(relabelled, deprecated)).toEqual([]);
  expect(checkExtensionUpdate(deprecated, relabelled)).toEqual([
    { pointer: `/terms/${rival}/deprecated`, code: 'unsupported' },
  ]);
  const changed = extension({
    ...valid.terms,
    [rival]: term({
      description: { en: 'Different.' },
      domain: ['schema:Organization'],
      targets: ['schema:Organization'],
    }),
    [mentor]: term({ relation: { group: 'order', inverse: 'none' } }),
  });
  expect(checkExtensionUpdate(valid, changed).map((violation) => violation.pointer)).toEqual([
    `/terms/${rival}/description`,
    `/terms/${rival}/domain`,
    `/terms/${rival}/targets`,
    `/terms/${mentor}/relation/group`,
    `/terms/${mentor}/relation/acyclic`,
    `/terms/${mentor}/relation/inverse`,
  ]);
  expect(
    checkExtensionUpdate(valid, extension({ [rival]: valid.terms[rival]! })).map((violation) => violation.pointer),
  ).toEqual([`/terms/${mentor}`]);
});

import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import { renderProfile, type PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import { establishedDeclarations } from '../compiler/registry.ts';
import { profileSource } from '../compiler/shacl.ts';
import * as fixedRelease from '../definitions/fixed-native-text-release-v1.ts';
import * as rightsOffering from '../definitions/rights-offering-v1.ts';
import * as translationLink from '../definitions/translation-link-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const definition = 'https://rezics.com/definition/';
const ids = ['fixed-native-text-release-v1', 'rights-offering-v1', 'translation-link-v1'];
const modules = [
  ['fixed-native-text-release-v1.ts', fixedRelease],
  ['rights-offering-v1.ts', rightsOffering],
  ['translation-link-v1.ts', translationLink],
] as const;
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));
const options = {
  established: Object.fromEntries(
    Object.entries(establishedDeclarations).filter(([id]) => ids.includes(id)),
  ),
  canonicalOrder: [],
  demandOrder: [],
};
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/work-release-turtle-'));
  temporary.push(path);
  return path;
}

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const normalize = (properties: readonly PropertyDefinition[]) =>
  properties
    .map((property) =>
      Object.fromEntries(Object.entries(property).sort(([a], [b]) => a.localeCompare(b))),
    )
    .sort(
      (a, b) =>
        String(a.path).localeCompare(String(b.path)) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );

const original = {
  'fixed-native-text-release-v1': {
    source: '0f1b6ac3b4891b845fe67b9cfc8ed8296dfa146ba44668645cf8d74a8a91ea22',
    comments: [
      'A separate sealed release pins one exact published native text selection.',
      'Its immutable manifest verifies the selected draft bytes; current Work metadata is not copied.',
      'The owning command guards current eligibility and sealed dependency identities.',
    ],
    roles: [{
      role: 'release',
      count: 17,
      hash: '55ebf17e8edc8186fd8011e5e8ee015e45f66cefb81d32cd9a297fd56ac872cb',
      alternatives: [],
    }],
  },
  'rights-offering-v1': {
    source: 'dd10150cfac446923dbb9ac8501f47a0a24bb292dd0eb4ddbad9449ed1746f85',
    comments: [
      'Rights declaration, license offering state and platform recognition as separate records.',
      'The slot holds at most one open offering per target/instrument key; an open offering',
      'revision has no predecessor, so ending is final and recognition cannot reopen it.',
    ],
    roles: [
      {
        role: 'declaration',
        count: 14,
        hash: '3525e0248dced8563a6c338d2f1c99198634dd7b193c3335da0b2c0116cecb4e',
        alternatives: [
          { count: 2, hash: '053d01f36f8f1308563c432d9ec67ad1c6f2dab2f456b3c31d89bdd7b67a7bda' },
          { count: 2, hash: 'c68c4bf4e8f94e6dfb93ed7ced787b1159e448d5222e6e72ed412a55d0f02b0e' },
        ],
        canonical: { types: ['rv:RightsDeclaration'] },
      },
      {
        role: 'slot',
        count: 4,
        hash: 'e8c198b50c5cdd4d00828261865916f38022dea1b844c6529e27acef7fa717da',
        alternatives: [],
        canonical: { types: ['rv:RightsOfferingSlot'] },
      },
      {
        role: 'offering',
        count: 5,
        hash: 'c10763390b14d30c999d19b32e85e094d4e73cebd6a7292fb35a01f9020aed2f',
        alternatives: [],
        canonical: { types: ['rv:RightsOffering'] },
      },
      {
        role: 'offering-revision',
        count: 9,
        hash: '5f7c301072025f33966863171bccbe03991564d1f6695527b1211eb72bcdf5ca',
        alternatives: [
          { count: 2, hash: 'e8c5586950c4b28261edac3ad46e255137f97d8735493a2acf11436aaef87a3a' },
          { count: 2, hash: '1426c04ee7d89bf49d45de41a93a3b3a755ac9ded60d759e92fdbf4ac75e6c78' },
        ],
        canonical: { types: ['rv:RightsOfferingRevision'] },
      },
      {
        role: 'recognition-revision',
        count: 10,
        hash: '19548c79199bdc7f0c5b11d3a7ba7254826162401bd3ec0f4b7744fab1df2215',
        alternatives: [],
        canonical: { types: ['rv:RightsRecognitionRevision'] },
      },
    ],
  },
  'translation-link-v1': {
    source: '4342e9d51554c176bda308d999f7620eb6b8b0096a1dab54e85a3265085a3f0e',
    comments: [
      'One independently published translated Work linked to one target Main Version revision.',
      'Official provenance requires an exact source revision and version-scoped authorization.',
      'An unresolved source version cannot be official; no body or later revision is inherited.',
    ],
    roles: [{
      role: 'link',
      count: 22,
      hash: 'f57019f818a8d7ed70d957e93a36dfa1b30750e913016952b854627a853e8951',
      alternatives: [
        { count: 6, hash: '646fdc51840c9a405005c4ef3b0bc7a868e999afa599bb3aa79defd0681ebc75' },
        { count: 6, hash: '7f0006926467534d4151650cc16161d4730b46a9396a4c6df91ff47f2343f851' },
        { count: 6, hash: '17357861ab7c25725799448d7cda1d96ef93831338cd55ece4d9d925b0050fcb' },
      ],
    }],
  },
} as const;

const outputs = buildModelOutputs(profiles);
let schemaPromise: Promise<Record<string, TSchema>> | undefined;
function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  const shape = (await schemas())[`${definition}${id}/${role}-shape`]!;
  return Value.Check(shape, value);
}

const translationLinkNode = (
  sourceVersionStatus: 'Exact' | 'Unresolved',
  translationStatus: 'Official' | 'ThirdParty',
  extra: Record<string, unknown> = {},
) => ({
  '@id': 'urn:translation:link',
  'rdf:type': [`${rv}TranslationLink`],
  'rv:targetWork': ['urn:work:target'],
  'rv:targetMainVersion': ['urn:work:target-main'],
  'rv:targetMainRevision': ['urn:work:target-revision'],
  'rv:sourceWork': ['urn:work:source'],
  'rv:sourceMainVersion': ['urn:work:source-main'],
  'rv:sourceVersionStatus': [`${rv}${sourceVersionStatus}`],
  'rv:translationStatus': [`${rv}${translationStatus}`],
  'rv:contentLanguage': ['en'],
  'rv:translator': ['urn:agent:translator'],
  'rv:publisher': ['urn:publisher:translation'],
  'rv:evidence': ['https://publisher.example/translation'],
  'rv:linkedBy': ['urn:agent:editor'],
  'rv:modelRevision': [`${definition}translation-link-v1`],
  'rv:shapeRevision': [`${definition}translation-link-v1`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['01234567-89ab-cdef-0123-456789abcdef'],
  'rv:sequence': [1],
  ...extra,
});

const fixedReleaseNode = () => ({
  '@id': 'urn:release:fixed',
  'rdf:type': [`${rv}FixedRelease`],
  'rv:work': ['urn:work:target'],
  'rv:mainVersion': ['urn:work:main'],
  'rv:mainRevision': ['urn:work:revision'],
  'rv:selection': ['urn:publication:selection'],
  'rv:contribution': ['urn:text:contribution'],
  'rv:publicationDecision': ['urn:publication:decision'],
  'rv:selectedDraft': ['urn:text:draft'],
  'rv:language': ['en'],
  'rv:bodyDigest': ['a'.repeat(64)],
  'rv:manifest': ['urn:release:manifest'],
  'rv:sealedBy': ['urn:agent:sealer'],
  'rv:modelRevision': [`${definition}fixed-native-text-release-v1`],
  'rv:shapeRevision': [`${definition}fixed-native-text-release-v1`],
  'rv:datasetId': ['urn:rezics:dataset:product'],
  'rv:dataEpoch': ['01234567-89ab-cdef-0123-456789abcdef'],
  'rv:sequence': [1],
});

const rightsDeclarationNode = (knowledge: 'Known' | 'Unknown') => ({
  '@id': 'urn:rights:declaration',
  'rdf:type': [`${rv}RightsDeclaration`, `${rv}RevisionAnchor`],
  'rv:target': ['urn:work:target'],
  'rv:declarationScope': ['urn:rights:scope'],
  'rv:instrument': ['urn:license:cc-by'],
  'rv:grantorKnowledge': [`${rv}${knowledge}`],
  ...(knowledge === 'Known' ? { 'rv:declaredBy': ['urn:agent:grantor'] } : {}),
  'rv:provenance': ['urn:evidence:declaration'],
  'rv:declarationOrigin': [`${rv}NativeDeclaration`],
  'rv:operation': ['urn:operation:rights-declaration'],
  'rv:dataEpoch': ['epoch-1'],
  'rv:sequence': [1],
  'rv:modelRevision': [`${definition}rights-offering-v1`],
});

const rightsRevisionReceipt = (operation: string) => ({
  'rv:operation': [operation],
  'rv:dataEpoch': ['epoch-1'],
  'rv:sequence': [1],
  'rv:modelRevision': [`${definition}rights-offering-v1`],
});

const rightsOfferingRevisionNode = (state: 'Open' | 'Ended', predecessor?: string) => ({
  '@id': 'urn:rights:offering-revision',
  'rdf:type': [`${rv}RightsOfferingRevision`, `${rv}RevisionAnchor`],
  'rv:offering': ['urn:rights:offering'],
  'rv:offeringState': [`${rv}${state}`],
  ...(predecessor ? { 'rv:predecessor': [predecessor] } : {}),
  'rv:changedBy': ['urn:agent:editor'],
  ...rightsRevisionReceipt('urn:operation:offering'),
});

const rightsRecognitionRevisionNode = (
  state: 'Recognized' | 'Invalidated',
  extra: Record<string, unknown> = {},
) => ({
  '@id': 'urn:rights:recognition-revision',
  'rdf:type': [`${rv}RightsRecognitionRevision`, `${rv}RevisionAnchor`],
  'rv:offering': ['urn:rights:offering'],
  'rv:recognitionState': [`${rv}${state}`],
  'rv:decidedBy': ['urn:agent:moderator'],
  ...rightsRevisionReceipt('urn:operation:recognition'),
  ...extra,
});

test('Turtle author sources preserve constraints, historical bytes, focus roles, declarations and exports', () => {
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(translationLink.translationLinkProfile.id).toBe('translation-link-v1');
  expect(fixedRelease.fixedNativeTextReleaseProfile.id).toBe('fixed-native-text-release-v1');
  expect(rightsOffering.rightsOfferingProfile.id).toBe('rights-offering-v1');

  const command = commandProfiles(profiles, options);
  const manifest = command.manifest as {
    profiles: {
      id: string;
      sha256: string;
      file: string;
      binding?: { required: string[]; optional: string[]; roles: string[] };
    }[];
    canonical: { type: string; routes: { profile: string; shape: string; when: unknown[] }[] }[];
    bindingDemands: { type: string; profile: string }[];
  };

  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    expect(profile.shapes).toHaveLength(baseline.roles.length);
    for (const [index, shape] of profile.shapes.entries()) {
      const expected = baseline.roles[index]!;
      const role = shape.iri.split('/').at(-1)!.slice(0, -6);
      expect(role).toBe(expected.role);
      expect(shape.properties).toHaveLength(expected.count);
      expect(digest(JSON.stringify(normalize(shape.properties)))).toBe(expected.hash);
      expect(shape.or?.map((branch) => branch.length) ?? []).toEqual(
        expected.alternatives.map((branch) => branch.count),
      );
      expect(shape.or?.map((branch) => digest(JSON.stringify(normalize(branch)))) ?? []).toEqual(
        expected.alternatives.map((branch) => branch.hash),
      );
      expect(shape.canonical).toEqual('canonical' in expected ? expected.canonical : undefined);
    }

    const published = manifest.profiles.find((item) => item.id === profile.id)!;
    const source = profileSource(profile);
    expect(command.shapes.get(published.file)).toBe(source);
    expect(digest(source)).toBe(baseline.source);
    expect(published.sha256).toBe(baseline.source);
    expect(digest(renderProfile({ ...profile, comments: [...baseline.comments] }))).toBe(
      baseline.source,
    );
  }

  expect(command.profiles.map((item) => [item.id, item.focusRoles])).toEqual([
    ['fixed-native-text-release-v1', ['release']],
    ['rights-offering-v1', [
      'declaration', 'slot', 'offering', 'offering-revision', 'recognition-revision',
    ]],
    ['translation-link-v1', ['link']],
  ]);
  expect(manifest.profiles.find((item) => item.id === 'translation-link-v1')?.binding).toEqual({
    required: ['link', 'target-work', 'target-main', 'target-revision', 'source-work', 'source-main',
      'status', 'language', 'translator', 'publisher', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
    optional: ['source-revision'],
    roles: ['link'],
  });
  expect(manifest.profiles.find((item) => item.id === 'fixed-native-text-release-v1')?.binding)
    .toEqual({
      required: ['release', 'work', 'main', 'revision', 'selection', 'contribution', 'decision', 'draft',
        'language', 'digest', 'manifest', 'actor', 'receipt', 'scope', 'epoch'],
      optional: [],
      roles: ['release'],
    });
  for (const [type, profile, role] of [
    [`${rv}TranslationLink`, 'translation-link-v1', 'link'],
    [`${rv}FixedRelease`, 'fixed-native-text-release-v1', 'release'],
    [`${rv}RightsDeclaration`, 'rights-offering-v1', 'declaration'],
    [`${rv}RightsOfferingSlot`, 'rights-offering-v1', 'slot'],
    [`${rv}RightsOffering`, 'rights-offering-v1', 'offering'],
    [`${rv}RightsOfferingRevision`, 'rights-offering-v1', 'offering-revision'],
    [`${rv}RightsRecognitionRevision`, 'rights-offering-v1', 'recognition-revision'],
  ]) {
    expect(manifest.canonical).toContainEqual({
      type,
      routes: [{
        profile,
        shape: `${definition}${profile}/${role}-shape`,
        when: [],
      }],
    });
  }
  expect(manifest.bindingDemands).toEqual(expect.arrayContaining([
    { type: `${rv}TranslationLink`, profile: 'translation-link-v1' },
    { type: `${rv}FixedRelease`, profile: 'fixed-native-text-release-v1' },
  ]));
});

test('Turtle discovery accepts only byte-matched profile exports and declarations', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, modules);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(discovered.map((profile) => profileSource(profile))).toEqual(
    profiles.map((profile) => profileSource(profile)),
  );

  const sourcePath = join(path, 'translation-link-v1.ttl');
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n# byte change\n`);
  expect(() => discoverProfiles(path, modules)).toThrow('Duplicate profile ID translation-link-v1');
});

test('translation alternatives preserve exact and unresolved provenance rules', async () => {
  const official = translationLinkNode('Exact', 'Official', {
    'rv:sourceMainRevision': ['urn:work:source-revision'],
    'rv:authorizingParty': ['urn:agent:authorizer'],
    'rv:authorizationScope': ['translation:authorize:urn:work:source:urn:work:source-revision'],
    'rv:authorizationEpoch': ['3'],
  });
  const exactThirdParty = translationLinkNode('Exact', 'ThirdParty', {
    'rv:sourceMainRevision': ['urn:work:source-revision'],
  });
  const unresolvedThirdParty = translationLinkNode('Unresolved', 'ThirdParty');

  for (const value of [official, exactThirdParty, unresolvedThirdParty])
    expect(await accepts('translation-link-v1', 'link', value)).toBe(true);

  for (const value of [
    translationLinkNode('Exact', 'Official', {
      'rv:sourceMainRevision': ['urn:work:source-revision'],
    }),
    translationLinkNode('Exact', 'ThirdParty', {
      'rv:sourceMainRevision': ['urn:work:source-revision'],
      'rv:authorizationScope': ['translation:authorize:wrong'],
    }),
    translationLinkNode('Unresolved', 'Official'),
    translationLinkNode('Unresolved', 'ThirdParty', {
      'rv:sourceMainRevision': ['urn:work:source-revision'],
    }),
    { ...official, 'rv:authorizationEpoch': ['03'] },
    { ...official, 'rv:contentLanguage': ['EN'] },
    { ...official, 'rv:evidence': ['http://publisher.example/translation'] },
  ])
    expect(await accepts('translation-link-v1', 'link', value)).toBe(false);
});

test('fixed release Turtle pins the complete sealed selection and rejects malformed digests', async () => {
  const valid = fixedReleaseNode();
  expect(await accepts('fixed-native-text-release-v1', 'release', valid)).toBe(true);
  for (const value of [
    { ...valid, 'rv:bodyDigest': ['A'.repeat(64)] },
    { ...valid, 'rv:bodyDigest': ['a'.repeat(63)] },
    { ...valid, 'rv:selectedDraft': [] },
    { ...valid, 'rv:shapeRevision': ['urn:revision:wrong'] },
    { ...valid, 'rv:dataEpoch': ['not-an-epoch'] },
    { ...valid, 'rv:sequence': [0] },
  ])
    expect(await accepts('fixed-native-text-release-v1', 'release', value)).toBe(false);
});

test('rights declaration, offering and recognition alternatives retain their state boundaries', async () => {
  expect(await accepts('rights-offering-v1', 'declaration', rightsDeclarationNode('Known'))).toBe(true);
  expect(await accepts('rights-offering-v1', 'declaration', rightsDeclarationNode('Unknown'))).toBe(true);
  expect(await accepts('rights-offering-v1', 'slot', {
    '@id': 'urn:rights:slot',
    'rdf:type': [`${rv}RightsOfferingSlot`],
    'rv:target': ['urn:work:target'],
    'rv:instrument': ['urn:license:cc-by'],
    'rv:openOffering': ['urn:rights:offering'],
  })).toBe(true);
  expect(await accepts('rights-offering-v1', 'offering', {
    '@id': 'urn:rights:offering',
    'rdf:type': [`${rv}RightsOffering`],
    'rv:slot': ['urn:rights:slot'],
    'rv:declaration': ['urn:rights:declaration'],
    'rv:offeringHead': ['urn:rights:offering-revision'],
    'rv:recognitionHead': ['urn:rights:recognition-revision'],
  })).toBe(true);
  expect(await accepts('rights-offering-v1', 'offering-revision', rightsOfferingRevisionNode('Open')))
    .toBe(true);
  expect(await accepts(
    'rights-offering-v1',
    'offering-revision',
    rightsOfferingRevisionNode('Ended', 'urn:rights:prior-revision'),
  )).toBe(true);
  expect(await accepts('rights-offering-v1', 'recognition-revision',
    rightsRecognitionRevisionNode('Recognized'))).toBe(true);
  expect(await accepts('rights-offering-v1', 'recognition-revision',
    rightsRecognitionRevisionNode('Invalidated', {
      'rv:predecessor': ['urn:rights:prior-recognition'],
      'rv:reason': ['Authority evidence was withdrawn.'],
    }))).toBe(true);

  for (const [role, value] of [
    ['declaration', {
      ...rightsDeclarationNode('Known'),
      'rv:declaredBy': [],
    }],
    ['declaration', {
      ...rightsDeclarationNode('Unknown'),
      'rv:declaredBy': ['urn:agent:grantor'],
    }],
    ['slot', {
      '@id': 'urn:rights:slot',
      'rdf:type': [`${rv}RightsOfferingSlot`],
      'rv:target': ['urn:work:target'],
      'rv:instrument': ['urn:license:cc-by'],
      'rv:openOffering': ['urn:rights:offering:one', 'urn:rights:offering:two'],
    }],
    ['offering', {
      '@id': 'urn:rights:offering',
      'rdf:type': [`${rv}RightsOffering`],
      'rv:slot': ['urn:rights:slot'],
      'rv:offeringHead': ['urn:rights:offering-revision'],
    }],
    ['offering-revision', rightsOfferingRevisionNode('Open', 'urn:rights:prior-revision')],
    ['offering-revision', rightsOfferingRevisionNode('Ended')],
    ['offering-revision', {
      ...rightsOfferingRevisionNode('Open'),
      'rv:offeringState': [`${rv}Invalid`],
    }],
    ['recognition-revision', rightsRecognitionRevisionNode('Recognized', { 'rv:reason': [''] })],
    ['recognition-revision', rightsRecognitionRevisionNode('Recognized', { 'rv:reason': ['x'.repeat(4001)] })],
  ] as const)
    expect(await accepts('rights-offering-v1', role, value)).toBe(false);
});

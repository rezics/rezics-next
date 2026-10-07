import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { authoredProfiles, commandProfiles, discoverProfiles } from '../compiler/generate.ts';
import type { PropertyDefinition } from '../compiler/ir.ts';
import { buildModelOutputs } from '../compiler/outputs.ts';
import {
  bindingDemandOrder,
  canonicalTypeOrder,
  establishedDeclarations,
} from '../compiler/registry.ts';
import { profileSource } from '../compiler/shacl.ts';
import * as classificationContext from '../definitions/classification-context-v1.ts';
import * as classificationDirectDecision from '../definitions/classification-direct-decision-v1.ts';
import * as classificationGlobalContext from '../definitions/classification-global-context-v1.ts';
import * as classificationProposition from '../definitions/classification-proposition-v1.ts';
import * as context from '../definitions/context-v1.ts';
import * as contextDefinitionEquivalence from '../definitions/context-definition-equivalence-v1.ts';
import * as contextDefinitionState from '../definitions/context-definition-state-v1.ts';
import * as contextSelectionModule from '../definitions/context-selection-v1.ts';

const root = resolve(import.meta.dir, '../..');
const rv = 'https://rezics.com/vocab/';
const skos = 'http://www.w3.org/2004/02/skos/core#';
const schema = 'https://schema.org/';
const definition = 'https://rezics.com/definition/';
const globalClassification = 'urn:rezics:classification-context:global';
const ids = [
  'classification-context-v1',
  'classification-direct-decision-v1',
  'classification-global-context-v1',
  'classification-proposition-v1',
  'context-definition-equivalence-v1',
  'context-definition-state-v1',
  'context-selection-v1',
  'context-v1',
];
const modules = [
  ['classification-context-v1.ts', classificationContext],
  ['classification-direct-decision-v1.ts', classificationDirectDecision],
  ['classification-global-context-v1.ts', classificationGlobalContext],
  ['classification-proposition-v1.ts', classificationProposition],
  ['context-definition-equivalence-v1.ts', contextDefinitionEquivalence],
  ['context-definition-state-v1.ts', contextDefinitionState],
  ['context-selection-v1.ts', contextSelectionModule],
  ['context-v1.ts', context],
] as const;
const profiles = authoredProfiles.filter((profile) => ids.includes(profile.id));

const selectedCanonicalTerms = [
  `<${rv}ClassificationApplication>`,
  `<${rv}ClassificationDecision>`,
  `<${rv}ClassificationSense>`,
  `<${rv}ClassificationContext>`,
  `<${skos}ConceptScheme>`,
  `<${skos}Concept>`,
  `<${rv}ConceptPath>`,
  `<${rv}ClassificationExpression>`,
];
const selectedBindingTerms = [
  `<${rv}ClassificationApplication>`,
  `<${rv}ClassificationDecision>`,
  `<${rv}ClassificationContext>`,
  `<${rv}ClassificationSense>`,
  `<${rv}ConceptPath>`,
  `<${rv}ClassificationExpression>`,
  `<${skos}Concept>`,
  `<${skos}ConceptScheme>`,
];
const options = {
  established: Object.fromEntries(
    Object.entries(establishedDeclarations).filter(([id]) => ids.includes(id)),
  ),
  canonicalOrder: canonicalTypeOrder.filter((term) => selectedCanonicalTerms.includes(term)),
  demandOrder: bindingDemandOrder.filter((term) => selectedBindingTerms.includes(term)),
};

const priorSourcePins = [
  ['fixed-native-text-release-v1', '0f1b6ac3b4891b845fe67b9cfc8ed8296dfa146ba44668645cf8d74a8a91ea22'],
  ['global-rating-standing-context-v1', 'fffed312c16e43a3e6d8fdda5f3947cb2d1a97b36778b128b6ce4667a78db76a'],
  ['global-rating-standing-observation-v1', 'dc2ad4e4ec21a66a78d1c416a4e8299e17a84e4530daccf330dbe3d3156ec9c9'],
  ['post-v1', 'aaa6e353c76cd215f5d64dbfcc0ae57846bb74e52f64e93582ffa6a1f27ec776'],
  ['realm-daily-rating-context-v1', '061f3a2c304b6d372c582af28facc91895ab2bfa1ca96da723dce737b484ca46'],
  ['realm-daily-rating-observation-v1', '514dbf814fef5943ad37da569c6768d2d94e2f48bcd4d5594b9efa26d4e67faf'],
  ['realm-experience-rating-context-v1', 'e74ba4e6db85146ab55978ad43240b66a3eaaee088e8f56c84373604e4330569'],
  ['realm-experience-rating-observation-v1', 'fe22f7a2143be4317ed09912ec3e4e799e525a30452df76c21d3d9a033093e65'],
  ['realm-release-rating-context-v1', 'a3edcb7334d29b923da433d5295aebf30d23d6dde295ebae32280e4fba275d49'],
  ['realm-release-rating-observation-v1', 'e1926bc5e8371333a5d32adf9ec4f9f03bc3e1cdb89e458e22006fa60775fecb'],
  ['realm-standing-rating-context-v1', '7bec3a7793417ef4138e54a6220ceaec7aa76e446df3a9fdadc9d1ba5cc35fab'],
  ['realm-standing-rating-observation-v1', 'd824ac73cde5f8a3a67f83339c4a3db9b982a8223b04f2277981d6adba33caa4'],
  ['realm-target-rating-context-v1', '30f3b40be8bee4466305813e8487ad5baee5a8e0caf4ed1753df6c42b7cc1cf2'],
  ['realm-target-rating-context-v2', '29a8fe741508eb591b0348ecb88f76f9693ea15256783298d78cb75d5ff8f936'],
  ['realm-target-rating-context-v3', 'a50948f15f468a27a6a68468c126d0a051cf703b1c4550ef7ff4f6e352c4c890'],
  ['realm-target-rating-context-v4', '86d150f2d1d56437e1843345d7dfa07ab2de6c134dff61e3314513296f73e32b'],
  ['realm-target-rating-observation-v1', '0169769b3c1179209e7205833b57b2dfb62c91603fc4efc098c0350d667e5d0c'],
  ['realm-target-rating-observation-v2', 'dbfdb6259c310991d57b339854f8ac138f3b42c8acfba780d9d932bab411a341'],
  ['realm-target-rating-observation-v3', '4dc4a035b1dae7714d354e730617f1f649561e99a8a76eeb0afaed4a7b742c0e'],
  ['realm-target-rating-observation-v4', '670763404c8cd86a0629e4e55f35fb5b560e95ca00c1f7aaac52749dd4ee7386'],
  ['rights-offering-v1', 'dd10150cfac446923dbb9ac8501f47a0a24bb292dd0eb4ddbad9449ed1746f85'],
  ['source-field-statement-v1', 'bc6c6397fb9ec6e4bf6bb44ffd933bf1abeaa7b83eb1939c57d32f438a2dcfb7'],
  ['source-open-library-work-v1', '460460ddffc2e3f6f8384402d54e521bef4f179b9ac6897fac98641acbc4390b'],
  ['source-reification-v1', '70f30519cefdb502ee86281b6edcdf18b7ced37209a90058113727abc521884c'],
  ['space-realm-v1', 'cccf212a73f4816603b0a1e55c1b0eb9b037f8794e576105e38fab65cb99218c'],
  ['space-realm-v2', '07a64922bd1042a99e98310f1e3e1068d348fbcd38380923917755a417e1f235'],
  ['space-realm-v3', 'ba178e0738b1c3f0a59c85dd85f044a3c00cadecb52874a66d838e75bbec510b'],
  ['translation-link-v1', '4342e9d51554c176bda308d999f7620eb6b8b0096a1dab54e85a3265085a3f0e'],
  ['work-address-claim-v1', '17326364438e3f150c7ff8e02e37e51596bed52049282f7b40a120c520503617'],
  ['work-address-disposition-v1', '9c4f852c5ff565984ef8a1c228d2c580b58c98c8e397cfdfb5305800fdc676de'],
  ['work-address-lifecycle-v1', '4057be5cb9790c3aa94c846707224cbe7c211f1eb3b3f17f03ecb3b039715134'],
  ['work-author-credit-v1', '40f7566879e80c782d418972aec38b5c1699ee0727c8eb56c128b719c606eb4a'],
  ['work-derivation-unresolved-v1', 'd47d816b777674c9142e2b7b3238f6728d4e89a072268a46acc0303cb992ad52'],
  ['work-derivation-v1', '27e4e0f2871f58bd1b7434dff809342721109220daec1b5b0f817da8abf176df'],
  ['work-reference-block-v1', 'c72c3a6b828632aeddc1a3078dead4dd0dfd0f989fca550530ad850dbcb9b9a0'],
  ['work-title-control-v1', '4b9028fab23fb2fa56e3be8ba4364cb15d0bcfdaaee646c868203fed48f26822'],
  ['zone-capability-v1', '1b5fa82ec8c40e4a6b6b25223a7ca7bebc573b517e900858895a5a12ff6424a5'],
  ['zone-presentation-v1', '6aecbd83013a8a9f9e2dc712d26b6450df29554f2f2c7d6174c2897b418bece7'],
  ['zone-presentation-v2', 'e331efea63e2bfb3ce883fb4d005ab63d7dd976973e43fd1599f655eef3ea730'],
] as const;

const original = {
  'context-v1': {
    source: 'd97d910f9feedbe38a7c95b62c52fd34af77683a5b6419ff6aee8f4c561da736',
    shapes: [
      { role: 'global', count: 8, hash: 'bf94a9b8d635704f9fd1a887338ee017c303466513cca4a37ae0b92c3360526e', alternatives: [], canonical: { types: ['rv:SemanticContext'], when: [{ path: 'rv:contextRole', value: 'rv:GlobalInterpretation' }] } },
      { role: 'context', count: 8, hash: 'e2cb1befbd351840cd917587c812ac07e2bb5eab69a1a64b410c88ba144fd112', alternatives: [], canonical: { types: ['rv:SemanticContext'] } },
      { role: 'semantic-revision', count: 15, hash: 'eb092656cf715f1326ab225cda4f03a3f826ace99a314df43c8fac65445118c7', alternatives: [], canonical: { types: ['rv:ContextSemanticRevision'] } },
      { role: 'entry', count: 4, hash: 'f8468cb14e17d5e9c9b8f900622a511293febd9038b6b701253e0c57b6f10572', alternatives: [
        { count: 2, hash: 'f5d4dbc7327d62680f3e09a28d4a4b534bd83cbe185750e3cc8dca88d0c46d41' },
        { count: 2, hash: '7210a4c811f937738eeb31453435ef5afbf3349a39d1a94835ac45d2172b02e5' },
      ], canonical: { types: ['rv:ContextEntry'] } },
      { role: 'preference-revision', count: 14, hash: '904e7258054198ee3b762b6ef927d1f57f53e89f801f9e66ece07792f2519180', alternatives: [], canonical: { types: ['rv:ContextPreferenceRevision'] } },
    ],
  },
  'context-selection-v1': {
    source: '4f8db2ae8afffc2e935afcac0fad2047c37474a3b3efb69b0a0d32e5d87efdc4',
    shapes: [
      { role: 'selection', count: 7, hash: 'dac7f23b93fd47259fae817397af548769576cd24a7d07ff19e2eafb1b677915', alternatives: [
        { count: 4, hash: 'a2aca6aee0e0f571d00bceda9b92c53571561b0a5d6ea2055c07f06abbf2867f' },
        { count: 4, hash: '637a6acac225464a9018e79f7de0b0fca94990c93c55a080138a8510c995aa51' },
        { count: 4, hash: '8f3fc30035156a9a303188253bdc6b8518f1720952d0eb27e6c60beb8d5f0fa9' },
        { count: 4, hash: '4c27cdba9d11a271a8157d0ce1ad75bbaab4414b33a24b500a0926dd2e4f840a' },
      ], canonical: { types: ['rv:ContextSelection'] } },
      { role: 'revision', count: 10, hash: '77d890f9710e27a519270411973bec17b99e30018083ef467400181a159f2223', alternatives: [
        { count: 4, hash: '2ad55ae29a50af5b069648599f796b2b6beee388f551ed5dbdfc6530fcee09c0' },
        { count: 4, hash: '1d58c9e8d2bd6964967a0ce553addf5214894742308bce1b0f734f2c87a144d6' },
      ], canonical: { types: ['rv:ContextSelectionRevision'] } },
    ],
  },
  'context-definition-state-v1': {
    source: 'd6c25bc9f0dd2face7a57a997babc888ecd0f7931af5066634d5aeafb85f8948',
    shapes: [
      { role: 'control', count: 4, hash: 'e4daa0acc4e5ebc76e859baff1da132bdde0145868e1cd72197432d0a8908522', alternatives: [], canonical: { types: ['rv:DefinitionLifecycle'] } },
      { role: 'revision', count: 12, hash: 'a643135d54103f5d0396ad6fa7fac1c159d766ff2c7379fc1bf8a8102a4a94e8', alternatives: [], canonical: { types: ['rv:DefinitionLifecycleRevision'] } },
    ],
  },
  'context-definition-equivalence-v1': {
    source: 'd70b454077f96a64b4c994ba987d95aeb58ba60071f8d2bbf8963d3e1b6c9daf',
    shapes: [
      { role: 'control', count: 4, hash: 'b1e7b88c472f425a924ad27bee7dfc505e2c57d06f194c021cebf74c6905db9f', alternatives: [], canonical: { types: ['rv:ContextDefinitionEquivalence'] } },
      { role: 'revision', count: 16, hash: '18bc11662620a2a82203c5aaf93a729da5c9fb428854a13270725b9068249c5f', alternatives: [], canonical: { types: ['rv:ContextDefinitionEquivalenceRevision'] } },
    ],
  },
  'classification-context-v1': {
    source: '41aa65a8f1f780d5902b858a8e9238d7e932afc88add4b23d731c51cfcd0bd20',
    shapes: [
      { role: 'global', count: 6, hash: '717e5b6ede705b9fcec3dddae5d93f61668165d36dbffa25acbad699120edceb', alternatives: [] },
      { role: 'realm', count: 3, hash: '5e825e9206278421245ad1013972ac3ff3a905923f8c77eced5d087309c9fb71', alternatives: [] },
      { role: 'context', count: 6, hash: 'd0dcc6bdf9377c8740591b15702fbbfe0db211fc766e97640829812656ce509c', alternatives: [] },
    ],
  },
  'classification-global-context-v1': {
    source: 'b54360592563a2f10b526fc9f8f6441727da2b941d351d31720e675df9242f07',
    shapes: [
      { role: 'global', count: 6, hash: '717e5b6ede705b9fcec3dddae5d93f61668165d36dbffa25acbad699120edceb', alternatives: [] },
    ],
  },
  'classification-proposition-v1': {
    source: '8bc799783d7d2c43da737b01d2b1f10bba4dc643716f1ac09524d1ef0e86dbd0',
    shapes: [
      { role: 'scheme', count: 2, hash: '72e42ba2654eec041b301f099dfaafd211de501d9a6a8d0f667740a47a6c43b2', alternatives: [] },
      { role: 'concept', count: 4, hash: '9b3bbfd1f302942a23a4e454fe4f84dfe7b6b91934da9f4efa6d40f1999ffb76', alternatives: [] },
      { role: 'path', count: 5, hash: '9d4ea35cccc80600a067e6f714b86e80eaee66a364de70711a53e7bfbefd038b', alternatives: [] },
      { role: 'expression', count: 5, hash: '28ccce1e96ce9356f6db4dc8f91846c258f6e5c0dd02bd16c0b8b1cfb20b66eb', alternatives: [] },
      { role: 'sense', count: 5, hash: '802477e96d883a576e6a2a28dba5d0770e3f6ce629bfdcfdd9d7d4503304e6e2', alternatives: [] },
    ],
  },
  'classification-direct-decision-v1': {
    source: 'c33d12713979c86a3d29aa2fc6ebd4952f37bdece02a5aa6ba485fc48bda468b',
    shapes: [
      { role: 'work', count: 2, hash: '25eb5a4f73cfca9b453372bb7b7c150c45964c4450532c239a785a30ea73a269', alternatives: [] },
      { role: 'main', count: 2, hash: '38c14aa447f6cc8bed594eeea701832a977c994aeb735cfe28393cd7bbd74bda', alternatives: [] },
      { role: 'sense', count: 4, hash: '7d85cc4033f10c63d35f9b9b1d7f6344f11429268672f0a24bfa5133c0cedd45', alternatives: [] },
      { role: 'context', count: 3, hash: 'd5b5e4f7c070109d900e3a8e7450fd066754b50e36eac34d2aa5701f1c1bc63f', alternatives: [] },
      { role: 'application', count: 8, hash: '00dad4af07691bcf13e96681c02eb6e90e624c7df7fbd801f3e03d9b6c5a457e', alternatives: [] },
      { role: 'decision', count: 8, hash: 'd7e9a209609acb82acc212b59dbc8200ec515383167eb270db4c7f27bcbc9067', alternatives: [] },
    ],
  },
} as const;

const outputs = buildModelOutputs(profiles);
let schemaPromise: Promise<Record<string, TSchema>> | undefined;
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/context-classification-turtle-'));
  temporary.push(path);
  return path;
}
function schemas(): Promise<Record<string, TSchema>> {
  if (!schemaPromise) {
    const path = join(directory(), 'schemas.ts');
    writeFileSync(path, outputs.get('packages/model/src/generated/schemas.ts')!);
    schemaPromise = import(path).then((module) => module.shapeSchemas as Record<string, TSchema>);
  }
  return schemaPromise;
}

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const normalize = (properties: readonly PropertyDefinition[]) =>
  properties
    .map((property) =>
      Object.fromEntries(
        Object.entries(property)
          .filter(([key]) => !['hasValueBeforeMaxCount', 'lineBreaks', 'wrapAfter'].includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .sort(
      (a, b) =>
        String(a.path).localeCompare(String(b.path)) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );

function propertyHash(properties: readonly PropertyDefinition[]): string {
  return digest(JSON.stringify(normalize(properties)));
}
async function accepts(id: string, role: string, value: Record<string, unknown>): Promise<boolean> {
  const shape = (await schemas())[`${definition}${id}/${role}-shape`]!;
  return Value.Check(shape, value);
}

const uri = (value: string) => `urn:context-test:${value}`;
const contextAnchor = (profile: string, component: string) => ({
  'rv:component': [component],
  'rv:authoredBy': [uri('author')],
  'rv:operation': [uri('operation')],
  'rv:modelRevision': [`${definition}${profile}`],
  'rv:shapeRevision': [`${definition}${profile}`],
  'rv:manifest': [uri('manifest')],
  'rv:dataEpoch': ['epoch-1'],
  'rv:sequence': [1],
});
const selectionRevisionAnchor = () => ({
  'rv:selectedBy': [uri('selector')],
  'rv:operation': [uri('operation')],
  'rv:modelRevision': [`${definition}context-selection-v1`],
  'rv:shapeRevision': [`${definition}context-selection-v1`],
  'rv:manifest': [uri('manifest')],
  'rv:dataEpoch': ['epoch-1'],
  'rv:sequence': [1],
});

const globalContext = () => ({
  '@id': globalClassification,
  'rdf:type': [`${rv}SemanticContext`],
  'rv:semanticHead': [uri('semantic-revision')],
  'rv:contextRole': [`${rv}GlobalInterpretation`],
  'rv:contextState': [`${rv}Active`],
  'rv:disclosure': [`${rv}Public`],
});
const sharedContext = () => ({
  '@id': uri('shared-context'),
  'rdf:type': [`${rv}SemanticContext`],
  'rv:semanticHead': [uri('semantic-revision')],
  'rv:preferenceHead': [uri('preference-revision')],
  'rv:contextRole': [`${rv}SharedInterpretation`],
  'rv:contextState': [`${rv}Retired`],
  'rv:disclosure': [`${rv}Private`],
});
const semanticRevision = () => ({
  '@id': uri('semantic-revision'),
  'rdf:type': [`${rv}ContextSemanticRevision`, `${rv}RevisionAnchor`],
  'rv:inheritanceDepth': [1],
  'rv:entryCount': [1],
  'rv:entry': [uri('entry')],
  ...contextAnchor('context-v1', uri('shared-context')),
});
const preferenceRevision = () => ({
  '@id': uri('preference-revision'),
  'rdf:type': [`${rv}ContextPreferenceRevision`, `${rv}RevisionAnchor`],
  'rv:preferenceCount': [0],
  ...contextAnchor('context-v1', uri('shared-context')),
});
const contextEntry = (state: 'Defined' | 'Unresolved' | 'Disabled') => ({
  '@id': uri('entry'),
  'rdf:type': [`${rv}ContextEntry`],
  'rv:entryTarget': [uri('target')],
  'rv:entryState': [`${rv}${state}`],
  ...(state === 'Defined' ? { 'rv:interpretationDefinition': [uri('definition')] } : {}),
});

const contextSelection = (
  kind: 'DefaultScope' | 'DomainScope' | 'ObjectScope' | 'ObjectRelationScope',
  scope: Record<string, unknown> = {},
) => ({
  '@id': uri('selection'),
  'rdf:type': [`${rv}ContextSelection`],
  'rv:consumer': [uri('consumer')],
  'rv:selectionRole': [`${rv}SpeakerSelection`],
  'rv:scopeProfile': [`${definition}context-selection-scope-v1`],
  'rv:selectionKey': [uri('selection-key')],
  'rv:contextSelectionHead': [uri('selection-revision')],
  'rv:scopeKind': [`${rv}${kind}`],
  ...scope,
});
const contextSelectionRevision = (
  state: 'Selected' | 'Cleared',
  fields: Record<string, unknown> = {},
) => ({
  '@id': uri('selection-revision'),
  'rdf:type': [`${rv}ContextSelectionRevision`, `${rv}RevisionAnchor`],
  'rv:component': [uri('selection')],
  'rv:selectionState': [`${rv}${state}`],
  ...selectionRevisionAnchor(),
  ...fields,
});

const lifecycleControl = () => ({
  '@id': uri('lifecycle'),
  'rdf:type': [`${rv}DefinitionLifecycle`],
  'rv:definitionRef': [uri('definition')],
  'rv:definitionState': [`${rv}Active`],
  'rv:definitionHead': [uri('lifecycle-revision')],
});
const lifecycleRevision = () => ({
  '@id': uri('lifecycle-revision'),
  'rdf:type': [`${rv}DefinitionLifecycleRevision`, `${rv}RevisionAnchor`],
  'rv:definitionRef': [uri('definition')],
  'rv:definitionState': [`${rv}Retired`],
  ...contextAnchor('context-definition-state-v1', uri('lifecycle')),
});
const equivalenceControl = () => ({
  '@id': uri('equivalence'),
  'rdf:type': [`${rv}ContextDefinitionEquivalence`],
  'rv:context': [uri('shared-context')],
  'rv:semanticRevision': [uri('semantic-revision')],
  'rv:equivalenceHead': [uri('equivalence-revision')],
});
const equivalenceRevision = () => ({
  '@id': uri('equivalence-revision'),
  'rdf:type': [`${rv}ContextDefinitionEquivalenceRevision`, `${rv}RevisionAnchor`],
  'rv:context': [uri('shared-context')],
  'rv:semanticRevision': [uri('semantic-revision')],
  'rv:entryRelation': [uri('relation')],
  'rv:leftTarget': [uri('left-target')],
  'rv:rightTarget': [uri('right-target')],
  'rv:leftDefinition': [uri('left-definition')],
  'rv:rightDefinition': [uri('right-definition')],
  'rv:reviewedBy': [uri('reviewer')],
  ...contextAnchor('context-definition-equivalence-v1', uri('equivalence')),
});

const classificationGlobal = () => ({
  '@id': globalClassification,
  'rdf:type': [`${rv}ClassificationContext`],
  'rv:contextRole': [`${rv}GlobalClassification`],
  'rv:contextState': [`${rv}Active`],
  'rv:inheritancePolicy': [`${definition}classification-isolate-v1`],
});
const realm = () => ({
  '@id': uri('realm'),
  'rdf:type': [`${rv}Realm`],
  'rv:realmState': [`${rv}Active`],
  'rv:classificationContext': [uri('realm-context')],
});
const realmClassification = () => ({
  '@id': uri('realm-context'),
  'rdf:type': [`${rv}ClassificationContext`],
  'rv:contextRole': [`${rv}RealmClassification`],
  'rv:contextState': [`${rv}Active`],
  'rv:realm': [uri('realm')],
  'rv:inheritancePolicy': [`${definition}classification-inherit-global-v1`],
  'rv:fallbackContext': [globalClassification],
});

const propositionNodes = () => ({
  scheme: {
    '@id': uri('scheme'),
    'rdf:type': [`${skos}ConceptScheme`],
    'rv:schemeState': [`${rv}Active`],
  },
  concept: {
    '@id': uri('concept'),
    'rdf:type': [`${skos}Concept`],
    'skos:inScheme': [uri('scheme')],
    'skos:prefLabel': [{ '@value': 'Mystery', '@language': 'en' }],
    'rv:conceptState': [`${rv}Active`],
  },
  path: {
    '@id': uri('path'),
    'rdf:type': [`${rv}ConceptPath`],
    'rv:pathKind': [`${rv}SingleConcept`],
    'rv:pathLength': [1],
    'rv:terminalConcept': [uri('concept')],
    'rv:pathState': [`${rv}Active`],
  },
  expression: {
    '@id': uri('expression'),
    'rdf:type': [`${rv}ClassificationExpression`],
    'rv:path': [uri('path')],
    'rv:propositionKind': [`${rv}ConceptAssertion`],
    'rv:assertedConcept': [uri('concept')],
    'rv:expressionState': [`${rv}Active`],
  },
  sense: {
    '@id': uri('sense'),
    'rdf:type': [`${rv}ClassificationSense`],
    'rv:path': [uri('path')],
    'rv:expression': [uri('expression')],
    'rv:interpretationScope': [globalClassification],
    'rv:senseState': [`${rv}Active`],
  },
});

const directDecisionNodes = () => ({
  work: {
    '@id': uri('work'),
    'rdf:type': [`${schema}CreativeWork`],
    'rv:mainVersion': [uri('main')],
  },
  main: {
    '@id': uri('main'),
    'rdf:type': [`${rv}MainVersion`],
    'rv:work': [uri('work')],
  },
  sense: {
    '@id': uri('sense'),
    'rdf:type': [`${rv}ClassificationSense`],
    'rv:senseState': [`${rv}Active`],
    'rv:interpretationScope': [globalClassification],
    'rv:head': [uri('sense-revision')],
  },
  context: {
    ...classificationGlobal(),
    'rv:inheritancePolicy': [`${definition}classification-isolate-v1`],
  },
  application: {
    '@id': uri('application'),
    'rdf:type': [`${rv}ClassificationApplication`],
    'rv:targetMainVersion': [uri('main')],
    'rv:sense': [uri('sense')],
    'rv:classificationContext': [globalClassification],
    'rv:applicationChannel': [`${rv}Curated`],
    'rv:applicationState': [`${rv}Active`],
    'rv:proposer': [uri('curator')],
    'rv:decisionHead': [uri('decision')],
  },
  decision: {
    '@id': uri('decision'),
    'rdf:type': [`${rv}ClassificationDecision`],
    'rv:application': [uri('application')],
    'rv:outcome': [`${rv}Accepted`],
    'rv:decisionBasis': [`${rv}GlobalCuratorReview`],
    'rv:decidedBy': [uri('curator')],
    'rv:decisionPolicy': [`${definition}classification-direct-decision-v1`],
  },
});

test('Turtle profiles preserve all source pins, property graphs, roles and command metadata', () => {
  expect(profiles.map((profile) => profile.id)).toEqual(ids);
  expect(context.contextProfile.id).toBe('context-v1');
  expect(contextSelectionModule.contextSelectionProfile.id).toBe('context-selection-v1');
  expect(contextDefinitionState.contextDefinitionStateProfile.id).toBe('context-definition-state-v1');
  expect(contextDefinitionEquivalence.contextDefinitionEquivalenceProfile.id)
    .toBe('context-definition-equivalence-v1');
  expect(classificationContext.classificationContextProfile.id).toBe('classification-context-v1');
  expect(classificationGlobalContext.classificationGlobalContextProfile.id)
    .toBe('classification-global-context-v1');
  expect(classificationProposition.classificationPropositionProfile.id)
    .toBe('classification-proposition-v1');
  expect(classificationDirectDecision.classificationDirectDecisionProfile.id)
    .toBe('classification-direct-decision-v1');

  expect(priorSourcePins).toHaveLength(39);
  for (const [id, sha256] of priorSourcePins)
    expect(digest(readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'))).toBe(sha256);

  const command = commandProfiles(profiles, options);
  const manifest = command.manifest as {
    profiles: { id: string; sha256: string; file: string; binding?: unknown }[];
    canonical: { type: string; routes: { profile: string; shape: string; when: { path: string; value: string }[] }[] }[];
    bindingDemands: { type: string; profile: string }[];
  };
  for (const profile of profiles) {
    const baseline = original[profile.id as keyof typeof original];
    expect(profile.binding).toBeUndefined();
    expect(profile.shapes).toHaveLength(baseline.shapes.length);
    for (const [index, shape] of profile.shapes.entries()) {
      const expected = baseline.shapes[index]!;
      expect(shape.iri.split('/').at(-1)!.slice(0, -6)).toBe(expected.role);
      expect(shape.properties).toHaveLength(expected.count);
      expect(propertyHash(shape.properties)).toBe(expected.hash);
      expect(shape.or?.map((branch) => branch.length) ?? []).toEqual(
        expected.alternatives.map((branch) => branch.count),
      );
      expect(shape.or?.map(propertyHash) ?? []).toEqual(
        expected.alternatives.map((branch) => branch.hash),
      );
      expect(shape.canonical).toEqual('canonical' in expected ? expected.canonical : undefined);
    }
    const published = manifest.profiles.find((item) => item.id === profile.id)!;
    expect(command.shapes.get(published.file)).toBe(profileSource(profile));
    expect(digest(profileSource(profile))).toBe(baseline.source);
    expect(published.sha256).toBe(baseline.source);
  }

  expect(command.profiles.map((item) => [item.id, item.focusRoles])).toEqual([
    ['classification-context-v1', ['global', 'realm', 'context']],
    ['classification-direct-decision-v1', ['work', 'main', 'sense', 'context', 'application', 'decision']],
    ['classification-global-context-v1', ['global']],
    ['classification-proposition-v1', ['scheme', 'concept', 'path', 'expression', 'sense']],
    ['context-definition-equivalence-v1', ['control', 'revision']],
    ['context-definition-state-v1', ['control', 'revision']],
    ['context-selection-v1', ['selection', 'revision']],
    ['context-v1', ['global', 'context', 'semantic-revision', 'entry', 'preference-revision']],
  ]);

  expect(manifest.canonical.slice(0, selectedCanonicalTerms.length).map((entry) => entry.type))
    .toEqual(selectedCanonicalTerms.map((term) => term.slice(1, -1)));
  const semanticContext = manifest.canonical.find((entry) => entry.type === `${rv}SemanticContext`)!;
  expect(semanticContext.routes).toEqual([
    {
      profile: 'context-v1',
      shape: `${definition}context-v1/global-shape`,
      when: [{ path: `${rv}contextRole`, value: `${rv}GlobalInterpretation` }],
    },
    { profile: 'context-v1', shape: `${definition}context-v1/context-shape`, when: [] },
  ]);
  const classificationRoutes = manifest.canonical.find(
    (entry) => entry.type === `${rv}ClassificationContext`,
  )!;
  expect(classificationRoutes.routes).toEqual([
    {
      profile: 'classification-context-v1',
      shape: `${definition}classification-context-v1/global-shape`,
      when: [{ path: `${rv}contextRole`, value: `${rv}GlobalClassification` }],
    },
    {
      profile: 'classification-context-v1',
      shape: `${definition}classification-context-v1/context-shape`,
      when: [],
    },
  ]);
  expect(classificationRoutes.routes.some((route) => route.profile === 'classification-global-context-v1'))
    .toBe(false);

  expect(manifest.profiles.find((entry) => entry.id === 'classification-context-v1')?.binding)
    .toEqual({ required: ['realm', 'context'], optional: [], roles: ['global', 'realm', 'context'] });
  expect(manifest.profiles.find((entry) => entry.id === 'classification-proposition-v1')?.binding)
    .toEqual({ required: ['scheme', 'concept', 'path', 'expression', 'sense'], optional: [],
      roles: ['scheme', 'concept', 'path', 'expression', 'sense'] });
  expect(manifest.profiles.find((entry) => entry.id === 'classification-direct-decision-v1')?.binding)
    .toEqual({
      required: ['work', 'main', 'sense', 'sense-revision', 'context', 'context-kind', 'application',
        'decision', 'slot', 'proposer', 'decider', 'outcome'],
      optional: ['realm', 'context-revision', 'predecessor'],
      roles: ['work', 'main', 'sense', 'context', 'application', 'decision'],
    });
  expect(manifest.bindingDemands.map((entry) => entry.type)).toEqual(
    selectedBindingTerms.map((term) => term.slice(1, -1)),
  );
});

test('Context headers, entries, revisions and public selection alternatives retain their bounds', async () => {
  expect(await accepts('context-v1', 'global', globalContext())).toBe(true);
  expect(await accepts('context-v1', 'context', sharedContext())).toBe(true);
  for (const [role, invalid] of [
    ['global', { ...globalContext(), 'rv:disclosure': [`${rv}Private`] }],
    ['global', { ...globalContext(), 'rv:realm': [uri('realm')] }],
    ['context', { ...sharedContext(), 'rv:principal': [uri('principal')] }],
    ['context', { ...sharedContext(), 'rv:semanticHead': [uri('head-1'), uri('head-2')] }],
  ] as const)
    expect(await accepts('context-v1', role, invalid)).toBe(false);

  expect(await accepts('context-v1', 'entry', contextEntry('Defined'))).toBe(true);
  expect(await accepts('context-v1', 'entry', contextEntry('Unresolved'))).toBe(true);
  expect(await accepts('context-v1', 'entry', contextEntry('Disabled'))).toBe(true);
  expect(await accepts('context-v1', 'entry', {
    ...contextEntry('Defined'), 'rv:interpretationDefinition': [],
  })).toBe(false);
  expect(await accepts('context-v1', 'entry', {
    ...contextEntry('Unresolved'), 'rv:interpretationDefinition': [uri('definition')],
  })).toBe(false);
  expect(await accepts('context-v1', 'entry', {
    '@id': uri('entry'), 'rdf:type': [`${rv}ContextEntry`], 'rv:entryTarget': [uri('target')],
  })).toBe(false);

  expect(await accepts('context-v1', 'semantic-revision', semanticRevision())).toBe(true);
  expect(await accepts('context-v1', 'semantic-revision', {
    ...semanticRevision(), 'rv:inheritanceDepth': [9],
  })).toBe(false);
  expect(await accepts('context-v1', 'semantic-revision', {
    ...semanticRevision(), 'rv:principal': [uri('principal')],
  })).toBe(false);
  expect(await accepts('context-v1', 'preference-revision', preferenceRevision())).toBe(true);
  expect(await accepts('context-v1', 'preference-revision', {
    ...preferenceRevision(), 'rv:entry': [uri('entry')],
  })).toBe(false);

  for (const [kind, scope] of [
    ['DefaultScope', {}],
    ['DomainScope', { 'rv:scopeDomain': [uri('domain')] }],
    ['ObjectScope', { 'rv:scopeObject': [uri('object')] }],
    ['ObjectRelationScope', { 'rv:scopeObject': [uri('object')], 'rv:scopeRelation': [uri('relation')] }],
  ] as const)
    expect(await accepts('context-selection-v1', 'selection', contextSelection(kind, scope))).toBe(true);
  expect(await accepts('context-selection-v1', 'selection', contextSelection('DefaultScope', {
    'rv:scopeObject': [uri('object')],
  }))).toBe(false);
  expect(await accepts('context-selection-v1', 'selection', contextSelection('ObjectRelationScope', {
    'rv:scopeObject': [uri('object')],
  }))).toBe(false);
  expect(await accepts('context-selection-v1', 'selection', {
    ...contextSelection('ObjectScope', { 'rv:scopeObject': [uri('object')] }),
    'rv:principal': [uri('principal')],
  })).toBe(false);

  expect(await accepts('context-selection-v1', 'revision', contextSelectionRevision('Selected', {
    'rv:context': [uri('shared-context')],
    'rv:semanticRevision': [uri('semantic-revision')],
    'rv:preferenceRevision': [uri('preference-revision')],
  }))).toBe(true);
  expect(await accepts('context-selection-v1', 'revision', contextSelectionRevision('Cleared'))).toBe(true);
  expect(await accepts('context-selection-v1', 'revision', contextSelectionRevision('Selected', {
    'rv:context': [uri('shared-context')],
  }))).toBe(false);
  expect(await accepts('context-selection-v1', 'revision', contextSelectionRevision('Cleared', {
    'rv:context': [uri('shared-context')],
  }))).toBe(false);
});

test('DefinitionRef lifecycle, equivalence, classification contexts and propositions keep their fixed values', async () => {
  expect(await accepts('context-definition-state-v1', 'control', lifecycleControl())).toBe(true);
  expect(await accepts('context-definition-state-v1', 'revision', lifecycleRevision())).toBe(true);
  expect(await accepts('context-definition-state-v1', 'control', {
    ...lifecycleControl(), 'rv:definitionState': [`${rv}Disabled`],
  })).toBe(false);
  expect(await accepts('context-definition-state-v1', 'revision', {
    ...lifecycleRevision(), 'rv:modelRevision': ['urn:wrong:profile'],
  })).toBe(false);

  expect(await accepts('context-definition-equivalence-v1', 'control', equivalenceControl())).toBe(true);
  expect(await accepts('context-definition-equivalence-v1', 'revision', equivalenceRevision())).toBe(true);
  expect(await accepts('context-definition-equivalence-v1', 'revision', {
    ...equivalenceRevision(), 'rv:rightDefinition': [],
  })).toBe(false);

  expect(await accepts('classification-context-v1', 'global', classificationGlobal())).toBe(true);
  expect(await accepts('classification-global-context-v1', 'global', classificationGlobal())).toBe(true);
  expect(await accepts('classification-context-v1', 'realm', realm())).toBe(true);
  expect(await accepts('classification-context-v1', 'context', realmClassification())).toBe(true);
  expect(await accepts('classification-context-v1', 'global', {
    ...classificationGlobal(), 'rv:realm': [uri('realm')],
  })).toBe(false);
  expect(await accepts('classification-context-v1', 'realm', {
    ...realm(), 'rv:classificationContext': [],
  })).toBe(false);
  expect(await accepts('classification-context-v1', 'context', {
    ...realmClassification(), 'rv:fallbackContext': [uri('other-global')],
  })).toBe(false);

  const proposition = propositionNodes();
  for (const [role, value] of Object.entries(proposition))
    expect(await accepts('classification-proposition-v1', role, value)).toBe(true);
  expect(await accepts('classification-proposition-v1', 'path', {
    ...proposition.path, 'rv:pathLength': [2],
  })).toBe(false);
  expect(await accepts('classification-proposition-v1', 'concept', {
    ...proposition.concept,
    'skos:prefLabel': [{ '@value': 'Mystery', '@language': 'fr' }],
  })).toBe(false);

  const direct = directDecisionNodes();
  for (const [role, value] of Object.entries(direct))
    expect(await accepts('classification-direct-decision-v1', role, value)).toBe(true);
  expect(await accepts('classification-direct-decision-v1', 'decision', {
    ...direct.decision, 'rv:outcome': [`${rv}Pending`],
  })).toBe(false);
  expect(await accepts('classification-direct-decision-v1', 'decision', {
    ...direct.decision, 'rv:decisionPolicy': [uri('other-policy')],
  })).toBe(false);
});

test('Turtle discovery keeps the named exports only when their exact source and declaration match', () => {
  const path = directory();
  for (const id of ids)
    writeFileSync(
      join(path, `${id}.ttl`),
      readFileSync(join(root, `model/definitions/${id}.ttl`), 'utf8'),
    );
  const discovered = discoverProfiles(path, modules);
  expect(discovered.map((profile) => profile.id)).toEqual(ids);
  expect(discovered.map(profileSource)).toEqual(profiles.map(profileSource));

  const sourcePath = join(path, 'context-v1.ttl');
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n# byte change\n`);
  expect(() => discoverProfiles(path, modules)).toThrow('Duplicate profile ID context-v1');
});

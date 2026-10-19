import { expect, test } from 'bun:test';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { namePolicyPrincipal } from '../src/modules/disclosure/viewer.ts';
import { checkedRealization, realizationDigest } from '../src/modules/realization/schema.ts';
import { verifyRealizationSourceNative } from '../src/modules/realization/source-verifier.ts';
import {
  checkedReleaseV2,
  releaseDigest,
  resolvedReleaseV2,
  type AnyReleaseRecord,
} from '../src/modules/release/schema.ts';
import { verifyReleaseSourceNative } from '../src/modules/release/source-verifier.ts';
import type {
  ReleaseNativeCommandBasis,
  ReleaseSourceNativeBasis,
  RealizationSourceNativeBasis,
  ReleaseSourceVerificationInput,
} from '../src/modules/source/release-native-verifier.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import {
  configureFixtureDisclosureAncestry,
  fixtureDisclosureReader,
} from './support/disclosure-ancestry.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const principal: VerifiedPrincipal = {
  issuer: 'https://accounts.example',
  subject: 'source-editor',
};
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const string = (lexical: string) => ({ kind: 'string' as const, lexical });

function fixture() {
  const work = id(1),
    release = id(2),
    realization = id(3),
    actor = id(4),
    translator = id(5);
  const releaseRevision = id(10),
    realizationRevision = id(11);
  const releaseAdmission = id(20).slice(-36),
    realizationAdmission = id(21).slice(-36);
  const releaseReceipt = workEditReceiptIri(releaseAdmission),
    realizationReceipt = workEditReceiptIri(realizationAdmission);
  const text = checkedRealization(
    {
      profile: 'realization-v1',
      expectedHead: null,
      actingSubject: actor,
      id: realization,
      language: 'zh-Hans',
      kind: 'translation',
      translators: [translator],
      publishers: [],
      source: { kind: 'unresolved', work },
      status: 'official',
      verification: 'verified',
      evidence: 'https://example.org/retained/release',
    },
    work,
  );
  const record = resolvedReleaseV2(
    checkedReleaseV2(
      {
        profile: 'release-v2',
        expectedHead: null,
        actingSubject: actor,
        id: release,
        kind: 'formal',
        status: 'official',
        title: { value: '紅樓夢', language: 'zh-Hant' },
        titleLanguage: null,
        tracklistLanguage: null,
        publisher: null,
        publicationYear: 1982,
        editionStatement: null,
        isbn13: null,
        originalUrl: null,
        fixedRelease: null,
        evidence: null,
        identifiers: [],
        platform: 'Windows',
        territory: null,
        coverage: [{ realization, revision: realizationRevision, completeness: 'complete' }],
      },
      work,
    ),
    [
      {
        realization,
        revision: realizationRevision,
        work,
        language: text.language,
        kind: text.kind,
        status: text.status,
      },
    ],
  );
  const state = {
    releaseHead: releaseRevision,
    realizationHead: realizationRevision,
    record: record as AnyReleaseRecord,
    text,
    missingReceipt: false,
    cancelledReceipt: false,
    missingState: false,
    ambiguousReceipt: false,
    visible: true,
    receiptComponent: release,
    receiptRevision: releaseRevision,
    digest: releaseDigest(record),
    finalHeads: undefined as (() => void) | undefined,
  };
  const queries: string[] = [],
    disclosures: { resource: string; revision?: string | null }[] = [];
  let writes = 0;
  const env = {
    lineage: { dataEpoch: 'fixture-epoch', routingEpoch: '1' },
    objectDirectory: 'unused',
    fuseki: {
      async query(query: string) {
        queries.push(query);
        if (query.includes('SELECT ?resource ?head')) {
          return { results: { bindings: [{ resource: uri(work), head: uri(id(30)) }] } };
        }
        if (query.includes('SELECT ?admission')) {
          if (state.missingReceipt) return { results: { bindings: [] } };
          const admission = query.includes(`<${releaseReceipt}>`)
            ? releaseAdmission
            : query.includes(`<${realizationReceipt}>`)
              ? realizationAdmission
              : null;
          const rows = admission ? [{ admission: literal(admission) }] : [];
          return { results: { bindings: state.ambiguousReceipt ? [...rows, ...rows] : rows } };
        }
        if (query.includes('SELECT ?outcome')) {
          const isRelease = query.includes(JSON.stringify(releaseAdmission));
          return {
            results: {
              bindings: [
                {
                  outcome: uri(`${RV}${state.cancelledReceipt ? 'Cancelled' : 'Succeeded'}`),
                  digest: literal(isRelease ? state.digest : realizationDigest(state.text)),
                  authority: literal('3'),
                  scope: literal(`work:edit:${work}`),
                  epoch: literal('fixture-epoch'),
                  sequence: literal(isRelease ? '8' : '7'),
                  work: uri(work),
                  component: uri(isRelease ? state.receiptComponent : realization),
                  revision: uri(isRelease ? state.receiptRevision : realizationRevision),
                },
              ],
            },
          };
        }
        if (query.includes('SELECT ?releaseHead')) {
          state.finalHeads?.();
          return {
            results: {
              bindings: [
                {
                  releaseHead: uri(state.releaseHead),
                  realizationHead: uri(state.realizationHead),
                },
              ],
            },
          };
        }
        if (query.includes('SELECT ?work ?head ?state')) {
          if (state.missingState) return { results: { bindings: [] } };
          const isRelease = query.includes('rv:releaseState');
          return {
            results: {
              bindings: [
                {
                  work: uri(work),
                  head: uri(isRelease ? state.releaseHead : state.realizationHead),
                  state: literal(JSON.stringify(isRelease ? state.record : state.text)),
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected owner query: ${query}`);
      },
      async commandWithReceipt() {
        writes += 1;
        throw new Error('verification cannot mutate native owners');
      },
    },
  } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(env, (target) =>
    target.work ? { resource: target.work, head: id(30) } : undefined,
  );
  configureDisclosure(
    env,
    fixtureDisclosureReader(async (targets, viewer) => {
      expect(namePolicyPrincipal(viewer)).toBe(principal);
      disclosures.push(...targets);
      return targets.map(() => (state.visible ? 'visible' : 'hidden'));
    }),
  );
  const releaseBasis: ReleaseNativeCommandBasis = {
    component: release,
    revision: releaseRevision,
    receipt: releaseReceipt,
    expectedHead: releaseRevision,
  };
  const textBasis: ReleaseNativeCommandBasis = {
    component: realization,
    revision: realizationRevision,
    receipt: realizationReceipt,
    expectedHead: realizationRevision,
  };
  const native: ReleaseSourceNativeBasis = {
    ...releaseBasis,
    owner: 'release',
    kind: 'component-property',
    target: work,
    property: { predicate: `${RV}platform`, value: string('Windows') },
    coverage: { realization: textBasis, completeness: 'complete' },
  };
  const input: ReleaseSourceVerificationInput<ReleaseSourceNativeBasis> = {
    principal,
    actingSubject: actor,
    native,
    selected: { value: string('Windows') },
  };
  const realizationInput: ReleaseSourceVerificationInput<RealizationSourceNativeBasis> = {
    principal,
    actingSubject: actor,
    native: {
      ...textBasis,
      owner: 'realization',
      kind: 'component-property',
      target: work,
      property: { predicate: `${RV}translator`, value: { kind: 'resource', ref: translator } },
      release: releaseBasis,
      completeness: 'complete',
    },
    selected: { value: { kind: 'resource', ref: translator } },
  };
  return {
    env,
    input,
    realizationInput,
    state,
    work,
    actor,
    translator,
    release,
    realization,
    releaseRevision,
    realizationRevision,
    releaseReceipt,
    realizationReceipt,
    queries,
    disclosures,
    writes: () => writes,
  };
}

test('release verifier resolves the actual receipt, exact selected property and both current owner heads', async () => {
  const f = fixture(),
    before = structuredClone(f.input);
  const result = await verifyReleaseSourceNative(f.env, f.input);
  expect(result).toMatchObject({
    status: 'verified',
    revision: f.releaseRevision,
    receipt: {
      receipt: f.releaseReceipt,
      outcome: 'succeeded',
      release: f.release,
      revision: f.releaseRevision,
    },
    native: f.input.native,
    selected: f.input.selected,
    headGuarantee: 'verified-before-commit',
    currentHeads: { release: f.releaseRevision, realization: f.realizationRevision },
    correspondence: {
      work: f.work,
      language: 'zh-Hans',
      completeness: 'complete',
      realization: {
        component: f.realization,
        revision: f.realizationRevision,
        receipt: f.realizationReceipt,
      },
    },
  });
  expect(f.input).toEqual(before);
  expect(f.writes()).toBe(0);
  expect(f.disclosures).toContainEqual(
    expect.objectContaining({ resource: f.release, revision: f.releaseRevision }),
  );
  expect(f.queries.filter((query) => query.includes('SELECT ?admission'))).toHaveLength(2);
  expect(f.queries.every((query) => query.includes('LIMIT 2'))).toBe(true);
});

test('realization verifier returns its own actual receipt and exact same-release translator', async () => {
  const f = fixture();
  const result = await verifyRealizationSourceNative(f.env, f.realizationInput);
  expect(result).toMatchObject({
    status: 'verified',
    revision: f.realizationRevision,
    receipt: { receipt: f.realizationReceipt, realization: f.realization },
    native: f.realizationInput.native,
    correspondence: {
      release: { component: f.release, receipt: f.releaseReceipt },
      language: 'zh-Hans',
    },
  });
  expect(f.writes()).toBe(0);
});

test('a component, descriptive event, revision or unknown receipt cannot masquerade as a command acknowledgement', async () => {
  for (const replacement of [id(90), id(91), `urn:rezics:receipt:${'f'.repeat(64)}`]) {
    const f = fixture();
    f.input.native.receipt = replacement;
    expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe(
      replacement.startsWith('urn:') ? 'unavailable' : 'target-mismatch',
    );
    expect(f.writes()).toBe(0);
  }
  for (const field of [
    'missingReceipt',
    'cancelledReceipt',
    'missingState',
    'ambiguousReceipt',
  ] as const) {
    const f = fixture();
    f.state[field] = true;
    expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('unavailable');
  }
});

test('wrong command target, revision, selected Work and forged request digest remain target mismatches', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.receiptComponent = id(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.receiptRevision = id(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.native.target = id(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.digest = 'f'.repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.native.coverage.realization.revision = id(40);
    },
  ]) {
    const f = fixture();
    change(f);
    expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('target-mismatch');
  }
});

test('selected values, same-release completeness and wrong translator remain value mismatches', async () => {
  const platform = fixture();
  platform.input.selected.value = string('Linux');
  expect((await verifyReleaseSourceNative(platform.env, platform.input)).status).toBe(
    'value-mismatch',
  );
  const coverage = fixture();
  coverage.input.native.coverage.completeness = 'partial';
  expect((await verifyReleaseSourceNative(coverage.env, coverage.input)).status).toBe(
    'value-mismatch',
  );
  const translator = fixture();
  translator.realizationInput.native.property.value = { kind: 'resource', ref: id(50) };
  translator.realizationInput.selected.value = { kind: 'resource', ref: id(50) };
  expect(
    (await verifyRealizationSourceNative(translator.env, translator.realizationInput)).status,
  ).toBe('value-mismatch');
});

test('moved release/text heads and movement during verification stay distinct from value mismatches', async () => {
  for (const field of ['releaseHead', 'realizationHead'] as const) {
    const f = fixture();
    f.state[field] = id(60);
    expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('head-mismatch');
  }
  const f = fixture();
  f.state.finalHeads = () => {
    f.state.releaseHead = id(61);
  };
  expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('head-mismatch');
});

test('the covered historical text stays exact with a separately checked newer current head', async () => {
  const f = fixture();
  f.state.realizationHead = id(70);
  f.input.native.coverage.realization.expectedHead = id(70);
  const result = await verifyReleaseSourceNative(f.env, f.input);
  expect(result).toMatchObject({
    status: 'verified',
    currentHeads: { realization: id(70) },
    correspondence: { realization: { revision: f.realizationRevision, expectedHead: id(70) } },
  });
  expect(f.queries.find((query) => query.includes('rv:realizationState'))).toContain(
    `<${f.realizationRevision}> a rv:RealizationRevision`,
  );
  expect(f.writes()).toBe(0);
});

test('language evidence is separate from UI locale and missing title language cannot earn support', async () => {
  const f = fixture();
  f.input.native.property = {
    predicate: 'https://schema.org/name',
    value: { kind: 'language-string', lexical: '紅樓夢', language: 'zh-Hant' },
  };
  f.input.selected = { value: f.input.native.property.value, language: 'zh-hant' };
  expect(await verifyReleaseSourceNative(f.env, f.input)).toMatchObject({
    status: 'verified',
    selected: { language: 'zh-hant' },
  });
  delete f.input.selected.language;
  expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('value-mismatch');
  f.input.selected.language = null;
  expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('value-mismatch');
});

test('year precision and unknown native values never borrow a more precise source date or territory', async () => {
  const f = fixture();
  f.input.native.property = {
    predicate: 'https://schema.org/datePublished',
    value: {
      kind: 'temporal',
      lexical: '1982',
      precision: 'year',
      calendar: 'gregorian',
    },
  };
  f.input.selected.value = f.input.native.property.value;
  expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('verified');
  f.input.selected.value = {
    kind: 'temporal',
    lexical: '1982-01',
    precision: 'month',
    calendar: 'gregorian',
  };
  expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('value-mismatch');
  f.input.native.property = { predicate: `${RV}territory`, value: string('CN') };
  f.input.selected.value = string('CN');
  expect((await verifyReleaseSourceNative(f.env, f.input)).status).toBe('value-mismatch');
});

test('private evidence and unavailable owner reads never return receipt or native fact details', async () => {
  const f = fixture();
  f.state.visible = false;
  const result = await verifyRealizationSourceNative(f.env, f.realizationInput);
  expect(result.status).toBe('unavailable');
  expect(result).not.toHaveProperty('receipt');
  expect(result).not.toHaveProperty('native');
  const missing = fixture();
  missing.env.fuseki.query = async () => {
    throw new Error('owner unavailable');
  };
  expect((await verifyReleaseSourceNative(missing.env, missing.input)).status).toBe('unavailable');
});

test('lost native reply verification is effect free and repeatable without allocating identities or supports', async () => {
  const f = fixture(),
    before = JSON.stringify(f.state);
  const first = await verifyReleaseSourceNative(f.env, f.input);
  expect(first.status).toBe('verified');
  expect(await verifyReleaseSourceNative(f.env, f.input)).toEqual(first);
  expect(JSON.stringify(f.state)).toBe(before);
  expect(f.writes()).toBe(0);
});

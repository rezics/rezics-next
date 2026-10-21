import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { associationCitation } from '../src/modules/query/association-contract.ts';
import { associationEvidenceCitation, manualAssociationCitation } from '../src/modules/relation/evidence-citation-contract.ts';
import { isAssociationEvidenceCitation, projectRetainedAssociationCitation,
  type RetainedSourceFieldCitationInput } from '../src/modules/relation/evidence-citation.ts';
import type { PublicRetainedFieldEvidence } from '../src/modules/source/retained-evidence.ts';
import { hash } from '../src/modules/work/activate.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const evidence = (): PublicRetainedFieldEvidence => ({ id: id(1), sourceWork: null,
  representationSha256: hash('retained bytes'), locator: { pointer: '/authors/3/credit~1name' },
  attribution: { sourceName: 'openlibrary', sourceUrl: 'https://openlibrary.org/works/OL42W', licence: 'CC0-1.0' },
  rightsBasis: { basisKind: 'unprotected_fact', basisRef: null, licenseExpression: 'CC0-1.0', notice: null,
    obligations: ['attribution'], useScope: 'quotation', result: 'supported', memberOrdinals: [0] },
  quote: 'An exact retained author', quoteWithheld: false, language: { state: 'omitted' } });
const input = (): RetainedSourceFieldCitationInput => ({ support: id(10), supportIdentity: id(20), evidence: evidence() });

test('manual citation transport keeps its existing closed shape and meaning', () => {
  const { '~unsafe': _staticType, ...manualSchema } = manualAssociationCitation;
  expect(Bun.deepEquals(manualSchema, associationCitation)).toBe(true);
  const manual = { id: id(10), sourceWork: id(2), representationSha256: hash('manual'), locator: { page: 3 },
    quote: null, quoteWithheld: true, method: { kind: 'manual' }, modality: 'quotation', submitter: id(3), rightsBasis: 'quotation' };
  expect(Value.Check(associationEvidenceCitation, manual)).toBe(true);
  expect(isAssociationEvidenceCitation(manual)).toBe(true);
  expect(Value.Check(associationEvidenceCitation, { ...manual, sourceWork: null })).toBe(false);
  expect(Value.Check(associationEvidenceCitation, { ...manual, kind: 'retained-source-field' })).toBe(false);
});

test('two supports of one retained record preserve both exact support and settlement identities', () => {
  const first = input(), second = { ...input(), support: id(11), supportIdentity: id(21) }, before = structuredClone(first);
  const a = projectRetainedAssociationCitation(first), b = projectRetainedAssociationCitation(second);
  expect([a.id, b.id]).toEqual([id(10), id(11)]);
  expect([a.supportIdentity, b.supportIdentity]).toEqual([id(20), id(21)]);
  expect(a.record).toBe(b.record);
  expect(a.record).toBe(first.evidence.id);
  expect(a.id).not.toBe(a.record);
  expect(a).toEqual({ ...first.evidence, kind: 'retained-source-field', id: first.support,
    supportIdentity: first.supportIdentity, record: first.evidence.id });
  expect(Value.Check(associationEvidenceCitation, a)).toBe(true);
  expect(a).not.toHaveProperty('method');
  expect(a).not.toHaveProperty('submitter');
  expect(a).not.toHaveProperty('modality');
  expect(first).toEqual(before);
});

test('retained language presence, frozen pointer and current withheld rights survive projection exactly', () => {
  for (const language of [{ state: 'omitted' }, { state: 'null' }, { state: 'value', value: '' },
    { state: 'value', value: ' EN-us ' }] as PublicRetainedFieldEvidence['language'][]) {
    const source = input(); source.evidence.language = language;
    const shown = projectRetainedAssociationCitation(source);
    expect(shown.language).toEqual(language);
    expect(shown.locator).toEqual(source.evidence.locator);
    source.evidence.quote = null; source.evidence.quoteWithheld = true;
    source.evidence.rightsBasis = { ...source.evidence.rightsBasis, result: 'undetermined', licenseExpression: null };
    const withheld = projectRetainedAssociationCitation(source);
    expect(withheld.quote).toBeNull();
    expect(withheld.quoteWithheld).toBe(true);
    expect(withheld.rightsBasis).toEqual(source.evidence.rightsBasis);
    expect(withheld.language).toEqual(language);
  }
});

test('a retained projection refuses missing identities, invalid pointers and contradictory quote permission', () => {
  const good = input();
  for (const change of [
    { ...good, support: '' }, { ...good, supportIdentity: '' },
    { ...good, evidence: { ...good.evidence, id: '' } },
    { ...good, evidence: { ...good.evidence, locator: { pointer: '/authors/~2' } } },
    { ...good, evidence: { ...good.evidence, language: { state: 'value', value: 'en\nprivate' } } },
    { ...good, evidence: { ...good.evidence, quoteWithheld: true } },
    { ...good, evidence: { ...good.evidence, rightsBasis: { ...good.evidence.rightsBasis, result: 'prohibited' } } },
  ]) expect(() => projectRetainedAssociationCitation(change as RetainedSourceFieldCitationInput)).toThrow(WorkReadUnavailable);
  const withPrivateField = { ...projectRetainedAssociationCitation(good), privateSupportCustodian: id(99) };
  expect(isAssociationEvidenceCitation(withPrivateField)).toBe(false);
});

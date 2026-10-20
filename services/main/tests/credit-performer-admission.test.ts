import { expect, test } from 'bun:test';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { authorCreditTriples, authorCreditValidations, creditProfile, verifyCreditModelPins,
  AuthorCreditUnavailable, type AuthorCreditValue } from '../src/modules/work/author-credit.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const roles = ['author', 'translator', 'editor', 'director', 'artist', 'animation-studio'] as const;
const command = { work: id(1), credit: id(2), expectedWorkHead: id(3), actingSubject: id(4) };
const participant = { kind: 'external-reference' as const, provider: 'vndb', namespace: 'staff', key: 's17' };
const value = (agent: boolean): AuthorCreditValue => ({ work: id(1), credit: id(2), revision: id(5),
  expectedHead: id(3), actingSubject: id(4), role: 'performer', sourceRoleKey: null,
  sourceKey: agent ? '' : 's17', nativeOrdinal: agent ? 0 : 2,
  ...(agent ? { agent: id(6) } : { provider: 'vndb', namespace: 'staff' }) });
const uri = (value: string) => ({ type: 'uri', value });

test('historical native command digests retain all six roles and both participant families', () => {
  expect(roles.map(role => nativeCreditDigest({ ...command, role, agent: id(6) }))).toEqual([
    '693e2154ca0b7adfb858d7757b2697cdb575880721d8761361eb4f0d31117687',
    'ad09379c39c64d0d22a126a42e07610b18f0c814c52db7287003d1620a996045',
    'be8378ad27e0526f105038890d53b85cd685c4637ab524f24f5c2ff7cb264d96',
    '919db5d81449a75c372df5a995b6b2074ddb467207d495128ce5b1903f189d0a',
    '873330ecc4fa4c3e57863392096e610385d167b2903bb262efe58d52fd5af3b5',
    '34c9936621024bced5cd907fccf8978e7fff910708d83a69d9ed160e3c7da153',
  ]);
  expect(roles.map(role => nativeCreditDigest({ ...command, role, participant, ordinal: 2 }))).toEqual([
    '77585ec79807add466a2880fc575cff619ee9442cbcb4401ac4c7c9ffc492b30',
    '7a311874ba2fc56623a7d9b51702c85616e45dd7d4727bba07ebd14067457ea0',
    '4b00ebdc42d16eb31a0dc77127bbe61d3974daca7a4c9dbacfb62e75a214eb38',
    '0cd623c1db2d3d0d764f243d83435fcdf6a6634fcad27b6620d2394e8ffcc1c2',
    '01d77661dc29d5010abceda3a985794b6289019a17a63192913107d646136481',
    'c7df1aa50e8dbf741a871cf2fd232c85368f919b4b327e906649d19344fa6046',
  ]);
});

for (const agent of [false, true]) {
  const family = agent ? 'native-agent-credit' : 'work-author-credit';
  const pin = `https://rezics.com/definition/${family}-v2`;
  test(`${family} Performer seals matching successor pins and exact owner validations`, async () => {
    const v = value(agent), triples = authorCreditTriples(v, 'credit-epoch', '12');
    expect(creditProfile(v)).toBe(`${family}-v2`);
    expect(triples.current).toContain(`rv:modelRevision <${pin}>`);
    expect(triples.revision).toContain(`rv:modelRevision <${pin}> ; rv:shapeRevision <${pin}>`);
    expect(triples.revision).toContain(`rv:workRevision <${v.expectedHead}>`);
    expect(triples.current.includes('rv:agent')).toBe(agent);
    expect(triples.current.includes('rv:externalKey')).toBe(!agent);
    const env = { fuseki: { async commandHealth() {
      return { profiles: Object.fromEntries(Object.entries(profileRegistry).map(([key, p]) => [key, p.sha256])) };
    } } } as unknown as WorkActivationEnvironment;
    const receipt = 'urn:rezics:receipt:work-edit:00000000-0000-4000-8000-000000000005';
    const validations = await authorCreditValidations(env, v, receipt, '7', v.credit);
    expect(validations.map(entry => entry.focus)).toEqual([[v.credit], [v.revision]]);
    for (const entry of validations) {
      expect(entry.profile).toBe(`${family}-v2`);
      expect(entry.shape.startsWith(`${pin}/`)).toBe(true);
      expect(entry.graphs).toEqual(agent ? [GRAPHS.current, GRAPHS.revisions]
        : [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control]);
      if (agent) expect(entry.binding).toBeUndefined();
      else expect(entry.binding).toMatchObject({ receipt, work: v.work, 'work-head': v.expectedHead,
        credit: v.credit, revision: v.revision, role: 'performer', provider: 'vndb', namespace: 'staff', key: 's17', ordinal: '2' });
    }
    const legacy = { ...v, role: 'author' as const };
    expect(creditProfile(legacy)).toBe(`${family}-v1`);
    expect(authorCreditTriples(legacy, 'credit-epoch', '12').current).not.toContain('rv:modelRevision');
    // An opaque provider key or namespace cannot select the successor.
    const opaque = { ...legacy, namespace: 'performer', sourceKey: 'performer' };
    expect(creditProfile(opaque)).toBe(`${family}-v1`);
  });

  test(`${family} owner reads require exact successor current/model/shape pins`, () => {
    const v = value(agent);
    verifyCreditModelPins(v, uri(pin), uri(pin), uri(pin));
    expect(v.modelRevision).toBe(pin);
    for (const [model, shape, current] of [
      [uri(pin), uri(pin), undefined],
      [uri(pin), uri(`${pin.slice(0, -1)}1`), uri(pin)],
      [uri(pin), uri(pin), uri('https://rezics.com/definition/other')],
      [{ type: 'literal', value: pin }, uri(pin), uri(pin)],
      [undefined, undefined, undefined],
    ] as const) expect(() => verifyCreditModelPins(value(agent), model, shape, current)).toThrow(AuthorCreditUnavailable);
    expect(() => creditProfile({ ...v, modelRevision: pin.replace(family, agent ? 'work-author-credit' : 'native-agent-credit') })).toThrow();
    expect(() => creditProfile({ ...v, modelRevision: `${pin.slice(0, -1)}1` })).toThrow();
  });
}

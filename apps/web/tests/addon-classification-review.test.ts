import { expect, test } from 'bun:test';
import {
  addonClassificationAdmitted,
  addonClassificationConfirmable,
  addonClassificationCopyKeepsValues,
  addonClassificationCopyPlan,
  addonClassificationCurrent,
  addonClassificationFocus,
  addonClassificationSelectedTarget,
  addonClassificationGrowthSizes,
  addonClassificationGrowthWork,
  addonClassificationIgnoresSuggestedWork,
  addonClassificationLeavesBaseMembership,
  addonClassificationOmitsBaseRelation,
  addonClassificationProperties,
  addonClassificationResendAllowed,
  addonClassificationStructuredParts,
  applyAddonClassificationCopy,
  bindAddonClassificationReview,
  populateAddonClassificationParts,
  retainAddonClassificationOrphan,
  withdrawnAddonClassificationBlocksIntent,
} from '../src/features/catalogue/addon-classification-review';
import { addonBase, addonType } from '../src/features/catalogue/addon-profile';
import { cloneReferenceGroup } from '../src/features/catalogue/reference-reuse';
import { statementInput } from '../src/features/catalogue/statement-editor';
import { factHolder, type FactDraft, type FactsCurrent } from '../src/features/catalogue/subject-facts';
import { addonProfileFixture, addonPlatformId, addonProfileId, addonWorkId } from '../src/kernel/fake/catalogue-addon-profile';

const genreConcept = '00000000-0000-4000-8000-00000000a106';
const platform = 'schema:gamePlatform';
const genre = 'schema:genre';

function current(): FactsCurrent {
  const fixture = addonProfileFixture();
  const loaded = addonClassificationCurrent({
    ok: true,
    release: fixture.release,
    public: fixture.current,
    work: fixture.work,
  });
  if (!loaded.ok) throw new Error('Expected add-on facts');
  const read = loaded;
  const seed = read.public.subject.statements['schema:inLanguage']![0]!;
  read.public.subject.statements[platform] = [
    {
      ...structuredClone(seed),
      id: '00000000-0000-4000-8000-00000000a111',
      property: { id: platform, data_type: 'wikibase-item' },
      value: { type: 'value', content: addonPlatformId },
      rank: 'preferred',
      qualifiers: [
        { property: { id: 'schema:inLanguage', data_type: 'string' }, value: { type: 'value', content: 'ja' } },
      ],
      references: [
        {
          hash: 'platform',
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: 'https://archive.example/addon/platform' },
            },
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: 'https://archive.example/addon/platform/note' },
            },
          ],
        },
      ],
    },
  ];
  read.public.subject.statements[genre] = [
    {
      ...structuredClone(seed),
      id: '00000000-0000-4000-8000-00000000a112',
      property: { id: genre, data_type: 'wikibase-item' },
      value: { type: 'value', content: genreConcept },
      references: [],
    },
  ];
  read.public.related[genreConcept] = { type: 'skos:Concept', labels: { en: 'Expansion genre' } };
  return read;
}

function draft(read: FactsCurrent, property: string): FactDraft {
  const selected = read.public.subject.statements[property]![0]!;
  const baseline = statementInput(selected);
  return {
    holder: crypto.randomUUID(),
    property,
    source: selected.id,
    baseline,
    included: true,
    statement: structuredClone(baseline),
  };
}

test('Add-on classification admits released item fields and keeps base membership and work suggestion distinct', () => {
  const read = current();
  expect(read.public.subject.type).toBe(addonType);
  expect(addonClassificationProperties(read)).toEqual(
    expect.arrayContaining([platform, genre, 'schema:keywords', 'wdt:P408']),
  );
  expect(addonClassificationAdmitted(read, platform)).toBe(true);
  expect(addonClassificationAdmitted(read, addonBase)).toBe(false);
  expect(
    addonClassificationSelectedTarget(read, platform, 'en', read.public.subject.statements[platform]![0]!.id),
  ).toMatchObject({ id: addonPlatformId, state: 'available' });
  const platformDraft = draft(read, platform);
  expect(addonClassificationOmitsBaseRelation(platformDraft)).toBe(true);
  expect(addonClassificationIgnoresSuggestedWork(platformDraft, addonWorkId)).toBe(true);
  const membership = read.public.subject.statements[addonBase]!;
  expect(addonClassificationLeavesBaseMembership(membership, structuredClone(membership))).toBe(true);
  expect(
    addonClassificationConfirmable({ drafts: [platformDraft], reviewCurrent: false, read, readFailed: false }),
  ).toBe(false);
  platformDraft.statement.value = { type: 'value', content: genreConcept };
  expect(
    addonClassificationConfirmable({ drafts: [platformDraft], reviewCurrent: true, read, readFailed: false }),
  ).toBe(true);
  expect(
    addonClassificationConfirmable({ drafts: [platformDraft], reviewCurrent: true, read, readFailed: true }),
  ).toBe(false);
  expect(withdrawnAddonClassificationBlocksIntent(read, 'schema:inLanguage', false)).toBe(true);
});

test('deliberate copy adds only an independent citation group and explains ineligible holders', () => {
  const read = current();
  const source = draft(read, platform);
  const target = draft(read, genre);
  const group = cloneReferenceGroup(source.statement.references[0]!);
  const plan = addonClassificationCopyPlan(
    [source, target],
    { holder: factHolder(source), property: source.property, groupIndex: 0, snapshot: group },
    read,
  );
  expect(plan.eligible).toEqual([factHolder(target)]);
  const copied = applyAddonClassificationCopy(
    [source, target],
    { holder: factHolder(source), property: source.property, groupIndex: 0, snapshot: group },
    [factHolder(target)],
    read,
  );
  expect(copied.applied).toEqual([{ holder: factHolder(target), property: genre, index: 0 }]);
  expect(addonClassificationCopyKeepsValues(target, copied.drafts[1]!)).toBe(true);
  expect(copied.drafts[1]!.statement.references[0]).toEqual(group);
  expect(copied.drafts[1]!.statement.references[0]).not.toBe(copied.drafts[0]!.statement.references[0]);
  copied.drafts[1]!.statement.references[0]!.parts[0]!.value = { type: 'value', content: 'https://other.example' };
  expect(copied.drafts[0]!.statement.references[0]!.parts[0]!.value).toEqual({
    type: 'value',
    content: 'https://archive.example/addon/platform',
  });
  const succeeded: FactDraft = { ...target, result: { ok: true, kind: 'proposed-awaiting-review', candidate: 'c1', revision: 2 } };
  expect(
    addonClassificationCopyPlan(
      [source, succeeded],
      { holder: factHolder(source), property: source.property, groupIndex: 0, snapshot: group },
      read,
    ).ineligible.some((item) => item.reason === 'succeeded'),
  ).toBe(true);
});

test('unknown delivery keeps the sealed key while a succeeded holder cannot resend, and removed diagnostics stay unfocusable', () => {
  const read = current();
  const uncertain: FactDraft = {
    ...draft(read, platform),
    command: { id: addonProfileId, key: '00000000-0000-4000-8000-00000000a201', statement: draft(read, platform).statement },
    result: { ok: false, reason: 'uncertain' },
  };
  const succeeded: FactDraft = {
    ...draft(read, genre),
    result: { ok: true, kind: 'proposed-awaiting-review', candidate: '00000000-0000-4000-8000-00000000a202', revision: 2 },
  };
  expect(addonClassificationResendAllowed(uncertain)).toBe(true);
  expect(addonClassificationResendAllowed(succeeded)).toBe(false);
  expect(
    addonClassificationConfirmable({ drafts: [uncertain], reviewCurrent: false, read, readFailed: true }),
  ).toBe(true);
  const invalid: FactDraft = {
    ...draft(read, genre),
    result: { ok: false, reason: 'invalid', errors: [{ pointer: '/statement/value', code: 'required' }] },
  };
  const orphans = retainAddonClassificationOrphan(invalid, []);
  expect(addonClassificationFocus(factHolder(invalid), [], orphans)).toBeNull();
});

test('projection and reuse stay bounded across 32, 64 and 128 admitted citation parts', () => {
  const read = current();
  const records = addonClassificationGrowthSizes.map((size) =>
    addonClassificationGrowthWork(read, size, (property) => draft(read, property)),
  );
  expect(records.map((item) => item.size)).toEqual([32, 64, 128]);
  for (const item of records) {
    expect(item.holders).toBe(2);
    expect(item.parts).toBeGreaterThanOrEqual(item.size);
    expect(item.projected).toBe(2);
    expect(item.copiedHolders).toBe(1);
    expect(item.copiedParts).toBe(16);
    expect(item.writes).toBe(2);
    expect(addonClassificationStructuredParts(item.rows[0]!.statement)).toBe(item.size);
  }
  expect(addonClassificationStructuredParts(populateAddonClassificationParts(draft(read, platform), 32).statement)).toBe(
    32,
  );
});

test('native selection rereads the add-on and never replays the proposal command', async () => {
  const events: string[] = [];
  const bound = bindAddonClassificationReview(
    () => ({
      read: async () => ({ ok: false as const, reason: 'denied' as const }),
      confirm: async () => {
        events.push('confirm');
        return { ok: true as const, kind: 'selected' as const, public: null };
      },
    }),
    async () => {
      events.push('current');
    },
    () => true,
    (property) => {
      events.push(property);
    },
  );
  await bound(platform, 'addon-session').confirm({} as never);
  expect(events).toEqual(['confirm', 'current', platform]);
  await bindAddonClassificationReview(
    () => ({
      read: async () => ({ ok: false as const, reason: 'denied' as const }),
      confirm: async () => ({ ok: true as const, kind: 'accepted' as const, public: null }),
    }),
    async () => {
      events.push('accepted-read');
    },
    () => true,
    () => {
      events.push('accepted-focus');
    },
  )(genre).confirm({} as never);
  expect(events).toEqual(['confirm', 'current', platform]);
});

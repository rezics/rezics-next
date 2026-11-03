import { expect, test } from 'bun:test';
import type { EditorRead } from '../src/features/catalogue/statement-editor';
import {
  factHolder,
  type FactDraft,
  type FactResult,
  type FactsCurrent,
  type FactsTransport,
} from '../src/features/catalogue/subject-facts';
import {
  applyStoryArcClassificationObservation,
  bindStoryArcClassificationReview,
  copyStoryArcClassificationEvidence,
  measureStoryArcClassificationWork,
  sendStoryArcClassificationChanges,
  storyArcClassificationAdmitted,
  storyArcClassificationBaseline,
  storyArcClassificationCandidateIdentity,
  storyArcClassificationChangedSet,
  storyArcClassificationConfirmable,
  storyArcClassificationCopyTargets,
  storyArcClassificationCurrent,
  storyArcClassificationDraft,
  storyArcClassificationEvidenceParts,
  storyArcClassificationFields,
  storyArcClassificationFocusable,
  storyArcClassificationOutcome,
  storyArcClassificationPartCount,
  storyArcClassificationProposedVisit,
  storyArcClassificationRemovedDiagnostics,
  storyArcClassificationRetry,
  storyArcClassificationSameUnknown,
  storyArcClassificationSnapshot,
  storyArcClassificationSubject,
  storyArcClassificationTransport,
  storyArcClassificationWithdrawn,
} from '../src/features/catalogue/story-arc-classification-review';
import { storyArcFacts, storyArcType } from '../src/features/catalogue/story-arc-profile';
import { storyArcProfileFixture, storyArcProfileId } from '../src/kernel/fake/catalogue-story-arc-profile';

const genre = 'schema:genre';
const keywords = 'schema:keywords';
const concept = '00000000-0000-4000-8000-00000000c101';
const other = '00000000-0000-4000-8000-00000000c102';
const evidence = 'https://archive.example/story-arc';

function current(): FactsCurrent {
  const fixture = storyArcProfileFixture();
  const read = storyArcClassificationCurrent({
    ok: true,
    release: fixture.release,
    arc: fixture.arc,
    work: fixture.work.publicRead,
  });
  if (!read.ok) throw new Error('Expected arc classification reading');
  const seed = {
    ...fixture.arc.subject.statements['schema:keywords']![0]!,
    qualifiers: [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' as const },
        value: { type: 'value' as const, content: { amount: '+1', unit: '1' } },
      },
    ],
    references: [
      {
        hash: 'grouped',
        parts: [
          { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value' as const, content: evidence } },
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value' as const, content: `${evidence}/note` },
          },
        ],
      },
    ],
    rank: 'preferred' as const,
  };
  read.public.subject.statements[genre] = [
    {
      ...seed,
      id: '00000000-0000-4000-8000-00000000c201',
      property: { id: genre, data_type: 'wikibase-item' },
      value: { type: 'value', content: concept },
    },
    {
      ...seed,
      id: '00000000-0000-4000-8000-00000000c211',
      property: { id: genre, data_type: 'wikibase-item' },
      value: { type: 'value', content: other },
      references: [],
    },
  ];
  read.public.subject.statements[keywords] = [
    {
      ...seed,
      id: '00000000-0000-4000-8000-00000000c202',
      property: { id: keywords, data_type: 'wikibase-item' },
      value: { type: 'value', content: other },
      references: [],
    },
  ];
  read.public.related[concept] = { type: 'skos:Concept', labels: { ja: '出典のジャンル' } };
  read.public.related[other] = { type: 'skos:Concept', labels: { en: 'Another concept' } };
  return read;
}

function change(draft: FactDraft, content: string): FactDraft {
  return {
    ...draft,
    statement: {
      ...draft.statement,
      value: { type: 'value', content },
      references: draft.statement.references.length
        ? draft.statement.references
        : [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: `${evidence}/${draft.property}` } },
              ],
            },
          ],
    },
  };
}

test('StoryArc classification identity uses the disclosed arc and ignores a work suggestion', async () => {
  const fixture = storyArcProfileFixture();
  const loaded = await fixture.transport.load({ id: storyArcProfileId, work: fixture.work.id });
  if (!loaded.ok) throw new Error('Expected profile');
  expect(storyArcClassificationFields(loaded.release)).toEqual([genre, keywords]);
  expect(storyArcClassificationSubject(loaded)).toEqual({ id: storyArcProfileId, type: storyArcType });
  const currentRead = storyArcClassificationCurrent(loaded);
  expect(currentRead.ok && currentRead.public.subject.id).toBe(storyArcProfileId);
  expect(storyArcFacts(loaded).ok && loaded.work?.subject.id).toBe(fixture.work.id);
  const observed = applyStoryArcClassificationObservation(loaded, {
    ok: true,
    release: loaded.release,
    public: loaded.work!,
    source: null,
  });
  expect(observed.arc?.subject.id).toBe(storyArcProfileId);
  const failed = applyStoryArcClassificationObservation(loaded, { ok: false, reason: 'unavailable' });
  expect(failed.arc).toEqual(loaded.arc);
});

test('readback observes current values, failures and reader retirement', async () => {
  const ready = { ok: true } as EditorRead;
  const observed: EditorRead[] = [];
  let reads = 0;
  const transport = {
    read: async () => {
      reads += 1;
      return ready;
    },
    propose: async () => ({ ok: false, reason: 'unavailable' }),
  } as unknown as FactsTransport;
  expect(
    await storyArcClassificationTransport(
      transport,
      () => true,
      (next) => observed.push(next),
    ).read(),
  ).toBe(ready);
  expect(
    await storyArcClassificationTransport(
      { ...transport, read: async () => Promise.reject(new Error('read failed')) },
      () => true,
      (next) => observed.push(next),
    ).read(),
  ).toMatchObject({ ok: false, reason: 'unavailable' });
  await expect(
    storyArcClassificationTransport(
      transport,
      () => false,
      (next) => observed.push(next),
    ).read(),
  ).rejects.toThrow('Retired catalogue editor');
  expect(reads).toBe(1);
  expect(observed).toHaveLength(2);
});

test('changed-set copy, independent outcomes, unknown retry and candidate-read stay per holder', async () => {
  const read = current();
  const genreDraft = change(
    storyArcClassificationDraft(read, genre, read.public.subject.statements[genre]![0]!.id)!,
    concept,
  );
  const keywordDraft = change(
    storyArcClassificationDraft(read, keywords, read.public.subject.statements[keywords]![0]!.id)!,
    other,
  );
  expect(genreDraft.statement.rank).toBe('preferred');
  expect(genreDraft.statement.qualifiers).toHaveLength(1);
  expect(storyArcClassificationAdmitted(read, genre)).toBe(true);
  const source = {
    holder: factHolder(genreDraft),
    property: genre,
    groupIndex: 0,
    snapshot: structuredClone(genreDraft.statement.references[0]!),
  };
  const eligibility = storyArcClassificationCopyTargets(
    [genreDraft, keywordDraft],
    source,
    read.release,
    new Set([genre, keywords]),
  );
  expect(eligibility).toEqual([
    expect.objectContaining({ holder: factHolder(keywordDraft), eligible: true, reason: null }),
  ]);
  const copied = copyStoryArcClassificationEvidence(
    [genreDraft, keywordDraft],
    source,
    [factHolder(keywordDraft)],
    read.release,
  );
  expect(copied.applied).toEqual([{ holder: factHolder(keywordDraft), property: keywords, index: 1 }]);
  copied.drafts[1]!.statement.references[1]!.parts[0]!.value = { type: 'value', content: `${evidence}/sibling` };
  expect(copied.drafts[0]!.statement.references[0]!.parts[0]!.value).toEqual({ type: 'value', content: evidence });
  expect(
    storyArcClassificationChangedSet(copied.drafts)
      .map((item) => item.property)
      .sort(),
  ).toEqual([genre, keywords]);
  expect(
    storyArcClassificationConfirmable({
      drafts: copied.drafts,
      reviewCurrent: true,
      admitted: new Set([genre, keywords]),
      readFailed: false,
    }),
  ).toBe(true);
  const commands: string[] = [];
  const results: FactResult[] = [];
  const sealed = await sendStoryArcClassificationChanges(
    storyArcProfileId,
    read.release,
    copied.drafts,
    async (command) => {
      commands.push(command.key);
      return command.statement.property.id === keywords
        ? { ok: false, reason: 'uncertain' }
        : {
            ok: true,
            kind: 'proposed-awaiting-review',
            candidate: '00000000-0000-4000-8000-00000000c301',
            revision: 2,
          };
    },
    (_property, result) => results.push(result),
  );
  expect(commands).toHaveLength(2);
  expect(new Set(commands).size).toBe(2);
  const proposed = { ...sealed[0]!, result: results.find((item) => item.ok)! };
  const unknown = { ...sealed[1]!, result: results.find((item) => !item.ok)! };
  expect(storyArcClassificationRetry(proposed)).toBeUndefined();
  expect(storyArcClassificationRetry(unknown)).toEqual(unknown.command);
  expect(storyArcClassificationSameUnknown(unknown, { ...unknown, statement: { ...unknown.statement } })).toBe(true);
  expect(storyArcClassificationCandidateIdentity(proposed.result!)).toBe('00000000-0000-4000-8000-00000000c301');
  expect(storyArcClassificationProposedVisit([proposed, unknown])).toEqual([
    { holder: factHolder(proposed), property: genre, candidate: '00000000-0000-4000-8000-00000000c301' },
  ]);
  expect(storyArcClassificationOutcome(proposed, read)).toBe('proposed');
  expect(storyArcClassificationOutcome(unknown, read)).toBe('uncertain');
  expect(storyArcClassificationBaseline({ ...genreDraft, source: 'gone' }, read)).toBe('withdrawn');
  const invalid = {
    ...keywordDraft,
    result: {
      ok: false as const,
      reason: 'invalid' as const,
      errors: [{ pointer: '/statement/value', code: 'required' }],
    },
  };
  const orphans = storyArcClassificationRemovedDiagnostics(invalid, []);
  expect(storyArcClassificationFocusable(factHolder(invalid), [], orphans)).toBeNull();
  expect(storyArcClassificationSnapshot({ status: 'current', fingerprint: 'old' }, copied.drafts).status).toBe('stale');
  const retired = { ...read, release: structuredClone(read.release) };
  delete retired.release.types[storyArcType]!.properties[
    retired.release.types[storyArcType]!.properties.indexOf(genre)
  ];
  retired.release.types[storyArcType]!.properties = retired.release.types[storyArcType]!.properties.filter(
    (property) => property !== genre,
  );
  expect(storyArcClassificationWithdrawn(retired, genre, genreDraft)).toBe(true);
});

test('native selection rereads this StoryArc and never replays the proposal', async () => {
  const events: string[] = [];
  const bound = bindStoryArcClassificationReview(
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
  await bound(genre, 'arc-session').confirm({} as never);
  expect(events).toEqual(['confirm', 'current', genre]);
});

test('projection and reuse stay bounded across 32, 64 and 128 admitted parts', () => {
  const read = current();
  const scales: { population: number; visited: number; copied: number; writes: number }[] = [];
  for (const population of [32, 64, 128]) {
    const sourceDraft = change(storyArcClassificationDraft(read, genre, null)!, concept);
    sourceDraft.statement.references = storyArcClassificationEvidenceParts(population, `${evidence}/${population}`);
    const target = change(storyArcClassificationDraft(read, keywords, null)!, other);
    expect(storyArcClassificationPartCount([sourceDraft])).toBe(population);
    scales.push(
      measureStoryArcClassificationWork({
        drafts: [sourceDraft, target],
        release: read.release,
        source: {
          holder: factHolder(sourceDraft),
          property: genre,
          groupIndex: 0,
          snapshot: structuredClone(sourceDraft.statement.references[0]!),
        },
        targets: [factHolder(target)],
      }),
    );
  }
  expect(scales.map((item) => item.population)).toEqual([32, 64, 128]);
  expect(scales.every((item) => item.copied === 1 && item.writes === 2 && item.visited >= item.population)).toBe(true);
});

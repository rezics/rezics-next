import { beforeAll, describe, expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { decideSubmission } from '../features/manage/commands.ts';
import { book, chapterOne, chapters, mod, names, occurrences, prompt, publishedRules, queue, records,
  works } from '../features/manage/fixtures.ts';
import { auditWorks, isSpoilerReason, reasonLabel, recordFacts, ruleFor, workTypeText } from '../features/manage/labels.ts';
import { messages } from '../features/manage/messages.ts';
import { mergeNames, noNames } from '../features/manage/queue-api.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

import { reviewedAs, subjectOf, targetWork } from '../features/manage/queue-subject.ts';
import { reasonsOf } from '../features/manage/queue-view.tsx';
import { chapterExcerpt } from '../features/manage/read.ts';
import { parseQueueView, queueHref } from '../features/manage/routes.ts';
import type { MainClient, ModerationItem } from '../features/manage/types.ts';

beforeAll(seedServedTypes);

const t = materializeData(messages, { locale: 'en' });
const uuid = (iri: string) => iri.slice(-36);

describe('G-395 what a queue item is about', () => {
  test('a chapter is named in its Book, wears the Book\'s cover and opens in the reader at that chapter', () => {
    const subject = subjectOf(chapterOne, names, t.workFallback);
    // The chapter's label in its Book, not its Work title, which still carries the Book's name.
    expect(subject.title?.value).toBe('第一章 雨夜');
    expect(subject.book?.value).toBe('雨夜书店 · 连载小说');
    expect(subject.text).toBe('第一章 雨夜 · 雨夜书店 · 连载小说');
    expect(subject.cover).toEqual({ iri: book, work: works[book] });
    expect(subject.href).toBe(`/w/${uuid(book)}/read/${uuid(occurrences.one)}`);
  });

  test('before its chapter is read, a chapter still names its Book; a chapter placed nowhere opens the Book\'s contents', () => {
    const early = subjectOf(chapterOne, { works, chapters: {} }, t.workFallback);
    expect(early.text).toBe('雨夜书店 · 第一章 雨夜 · 雨夜书店 · 连载小说');
    const unplaced = subjectOf(chapterOne, { works: { ...works, [chapterOne]: { ...works[chapterOne]!,
      partOf: { work: book, occurrence: null } } }, chapters }, t.workFallback);
    expect(unplaced.href).toBe(`/w/${uuid(book)}/contents`);
    const unknown = subjectOf('https://rezics.com/id/00000000-0000-4000-8000-000000009999', noNames, t.workFallback);
    expect(unknown).toMatchObject({ title: null, book: null, text: 'A Work',
      href: '/w/00000000-0000-4000-8000-000000009999' });
  });

  test('a chapter whose own record is private is placed in its Book by the moderation context', () => {
    const { [chapterOne]: _private, ...readable } = works;
    const subject = subjectOf(chapterOne, { works: readable, chapters, facts: names.facts }, t.workFallback);
    expect(subject).toMatchObject({ work: undefined, text: '第一章 雨夜 · 雨夜书店 · 连载小说',
      cover: { iri: book }, href: `/w/${uuid(book)}/read/${uuid(occurrences.one)}` });
  });

  test('a report on a Work\'s record or on its published text is about that Work; other owners name none', () => {
    expect(targetWork({ owner: 'graph', resource: chapterOne })).toBe(chapterOne);
    expect(targetWork({ owner: 'content', resource: chapterOne })).toBe(chapterOne);
    expect(targetWork({ owner: 'media', resource: chapterOne })).toBeNull();
    expect(targetWork({ owner: 'content', resource: 'urn:rezics:variant:x' })).toBeNull();
    expect(auditWorks([{ id: 'a', caseId: 'c', kind: 'content_moderation', outcome: 'dismiss', reason: null, detail: null,
      actingSubject: book, decidedAt: '2026-09-28T00:00:00.000Z', caseSequence: '1',
      target: { owner: 'content', resource: chapterOne, component: 'body' } }])).toEqual([chapterOne]);
  });

  test('a Work says what it is, and mods, prompts and skills have their own facts to review', () => {
    seedServedTypes();
    expect(workTypeText(works[chapterOne], 'en', t)).toBe('Chapter');
    expect(workTypeText(works[book], 'en', t)).toBe('Book');
    expect(workTypeText(works[prompt], 'ja', t)).toBe('プロンプト');
    expect(workTypeText(works[mod], 'en', t)).toBe('Mod');
    expect([reviewedAs(works[mod], names.facts?.[mod]), reviewedAs(works[prompt], undefined),
      reviewedAs(works[book], undefined)]).toEqual(['mod', 'prompt', null]);
  });

  test('a chapter\'s opening drops the heading its text repeats and stops at a paragraph', () => {
    expect(chapterExcerpt('第一章 雨夜\n雨停了。\n\n信来了。', '第一章 雨夜')).toEqual({ excerpt: '雨停了。\n信来了。',
      truncated: false });
    const long = `${'甲'.repeat(700)}\n${'乙'.repeat(700)}`;
    expect(chapterExcerpt(long, null, 1_000)).toEqual({ excerpt: '甲'.repeat(700), truncated: true });
    expect(chapterExcerpt('   \n', null)).toEqual({ excerpt: null, truncated: false });
  });
});

describe('G-395 who raised it and what they may break', () => {
  test('a report naming a rule by id cites it by number; platform reason codes cite none', () => {
    const rules = publishedRules();
    expect(ruleFor('no-spoilers', rules)).toMatchObject({ number: 1, rule: { id: 'no-spoilers' } });
    expect(ruleFor('rule.be-kind', rules)).toMatchObject({ number: 3 });
    expect(ruleFor('edition_details', rules)).toBeNull();
    expect(ruleFor(null, rules)).toBeNull();
    expect([isSpoilerReason('spoiler.in_title'), isSpoilerReason('spoilers'), isSpoilerReason('spoiled_milk'),
      isSpoilerReason(null)]).toEqual([true, true, false, false]);
  });

  test('a reason naming a rule reads as the rule\'s title in the reader\'s language; others as their words', () => {
    const rules = publishedRules('zh-CN');
    expect(reasonLabel({ kind: 'content_report', reasonCode: 'no-spoilers' }, t, rules)).toBe('标题中不要剧透');
    expect(reasonLabel({ kind: 'content_report', reasonCode: 'title_review' }, t, rules)).toBe('Title needs review');
    // A submission's reason is the reviewer's own words, never a rule's title.
    expect(reasonLabel({ kind: 'work_submission', reasonCode: 'no-spoilers' }, t, rules)).toBe('no-spoilers');
  });

  test('a record reads as standing and outcomes, and a first submission or report says so', () => {
    const banned = recordFacts(records[Object.keys(records)[1]!]!, t, 'en');
    expect(banned).toMatchObject({ banned: true, standing: 'Banned until Oct 5, 2026',
      submissions: ['3 rejected', '2 waiting', '1 withdrawn'], reports: null });
    const newcomer = recordFacts({ agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000020',
      membership: { state: 'not_joined', joinedAt: null, banned: false, bannedUntil: null },
      submissions: { open: 1, accepted: 0, rejected: 0, changesRequested: 0, withdrawn: 0, total: 1, capped: false },
      reports: { open: 1, upheld: 0, dismissed: 0, total: 1, capped: false } }, t, 'en');
    expect(newcomer).toEqual({ banned: false, standing: 'Not a member', submissions: ['First submission here'],
      reports: ['First report here'] });
    const prolific = recordFacts({ agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000021', membership: { state: 'joined',
      joinedAt: '2025-01-02T00:00:00.000Z', banned: false, bannedUntil: null }, submissions: null,
      reports: { open: 10, upheld: 900, dismissed: 90, total: 1000, capped: true } }, t, 'en');
    expect(prolific).toMatchObject({ standing: 'Member since Jan 2, 2025',
      reports: ['900 upheld', '90 not upheld', '10 open', '1000+ in all'] });
  });
});

describe('G-395 filters and names', () => {
  test('reasons narrow reports only, and live in the address', () => {
    const realm = '00000000-0000-4000-8000-000000000001';
    expect(parseQueueView({ reason: 'spoiler.in_title' })).toEqual({ state: 'open', type: null, reason: 'spoiler.in_title' });
    expect(parseQueueView({ type: 'work_submission', reason: 'spoiler.in_title' }))
      .toEqual({ state: 'open', type: 'work_submission', reason: null });
    expect(parseQueueView({ reason: 'Not a code' }).reason).toBeNull();
    expect(parseQueueView({ type: 'content-publication_submission' }).type).toBe('content-publication_submission');
    expect(queueHref(realm, { state: 'open', type: 'content_report', reason: 'title_review' }))
      .toBe(`/manage/r/${realm}?type=content_report&reason=title_review`);
    expect(queueHref(realm, { state: 'open', type: 'work_submission', reason: 'title_review' }))
      .toBe(`/manage/r/${realm}?type=work_submission`);
    expect(reasonsOf(queue, null)).toEqual(['edition_details', 'no-spoilers', 'spoiler.in_title', 'title_review',
      'unlicensed_copy', 'unsafe_instructions']);
    expect(reasonsOf([], 'spam')).toEqual(['spam']);
  });

  test('names read later add to what is known and never erase a known name', () => {
    const known = mergeNames(noNames, { works: { [book]: works[book]! }, agents: { a: { iri: 'a', label: 'An', handle: null } } });
    const merged = mergeNames(known, { agents: { a: { iri: 'a', label: null, handle: null } }, chapters });
    expect(merged.agents.a?.label).toBe('An');
    expect(merged.works[book]).toBe(works[book]);
    expect(Object.keys(merged.chapters)).toEqual(Object.keys(chapters));
  });
});

describe('G-395 accepting a whole Work or a publication', () => {
  const realm = '00000000-0000-4000-8000-000000000001';
  const acting = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
  /** A client whose Realm lists `slots` and records the decision it was sent. */
  function main(slots: Array<{ kind: string; resource: string; variant: string; selection: string }>) {
    const sent: unknown[] = [];
    const answer = <T>(data: T) => Promise.resolve({ data, error: null });
    const client = { v1: { realms: () => ({
      'submitted-publications': { get: () => answer({ items: slots }) },
      submissions: () => ({ decisions: { post: (body: unknown) => { sent.push(body); return answer({}); } } }),
    }) } } as unknown as MainClient;
    return { client, sent };
  }
  const work = queue.find(item => item.kind === 'work_submission')!;
  const publication = queue.find(item => item.kind === 'content-publication_submission')!;

  test('the first acceptance expects an empty slot; a later one the slot\'s current selection', async () => {
    const empty = main([]);
    await decideSubmission(empty.client, realm, work, { action: 'approve', reason: null, note: null }, acting, 'key');
    expect(empty.sent).toEqual([expect.objectContaining({ outcome: 'accept', expectedSelectionHead: null })]);
    const selection = 'https://rezics.com/id/00000000-0000-4000-8000-000000000777';
    const held = main([{ kind: 'work', resource: work.target.resource, variant: 'urn:rezics:variant:x', selection }]);
    await decideSubmission(held.client, realm, work, { action: 'approve', reason: null, note: null }, acting, 'key');
    expect(held.sent).toEqual([expect.objectContaining({ expectedSelectionHead: selection })]);
  });

  test('a publication\'s slot is its own variant\'s, never another chapter\'s or the whole Work\'s', async () => {
    const other: ModerationItem = { ...publication, target: { ...publication.target, component: 'urn:rezics:variant:other' } };
    const selection = 'https://rezics.com/id/00000000-0000-4000-8000-000000000778';
    const slots = [{ kind: 'work', resource: publication.target.resource, variant: 'v', selection: 'wrong' },
      { kind: 'content-publication', resource: publication.target.resource, variant: publication.target.component,
        selection }];
    const exact = main(slots);
    await decideSubmission(exact.client, realm, publication, { action: 'approve', reason: null, note: null }, acting, 'k');
    expect(exact.sent).toEqual([expect.objectContaining({ expectedSelectionHead: selection })]);
    const elsewhere = main(slots);
    await decideSubmission(elsewhere.client, realm, other, { action: 'approve', reason: null, note: null }, acting, 'k');
    expect(elsewhere.sent).toEqual([expect.objectContaining({ expectedSelectionHead: null })]);
  });
});

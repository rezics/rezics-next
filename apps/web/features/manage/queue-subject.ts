import { resourceHref, type AddressTarget } from '../address/path.ts';
import { typeEntry } from '../catalogue/types.ts';
import { chapterPlaceHref } from '../work-page/route.ts';
import type { ChapterSummary, WorkFacts, WorkSummary } from './types.ts';
import type { ContractOf } from 'native-i18n';
import type { ManageMessages } from './messages.ts';

/**
 * The catalogue resource a moderation target is about: a Work's record
 * (`graph`), or published text (`content`, including chapter Posts).
 */
export function targetWork(target: { owner: string; resource: string }): string | null {
  return (target.owner === 'graph' || target.owner === 'content')
    && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target.resource) ? target.resource : null;
}

/** A name as the page sets it: its text and, when Main knows it, its language and direction for `lang` and `dir`. */
export interface ShownName { value: string; language?: string; direction?: 'ltr' | 'rtl' }

/**
 * What a queue item or log entry is about, as a moderator recognizes it. A
 * chapter is never a Work of its own here: it is named in its Book
 * ("第一章 雨夜 · 雨夜书店"), wears the Book's cover and opens in the reader at
 * that chapter.
 */
export interface Subject {
  /** The Work or Post the item points at. */
  iri: string;
  /** Its header, when Main named it. */
  work: WorkSummary | undefined;
  /** The Work whose cover is drawn: the Book for a chapter. */
  cover: { iri: string; work: WorkSummary | undefined };
  /** The chapter's label in its Book, or the Work's title; null until Main names it. */
  title: ShownName | null;
  /** The Book that places a chapter Post; null for any other subject. */
  book: ShownName | null;
  /** Both as one line of plain text, for toasts, labels and titles. */
  text: string;
  /** Where to open it: the reader at the chapter, or the Work's page. */
  href: string;
  isChapter: boolean;
  chapter: ChapterSummary | undefined;
}

const named = (work: WorkSummary | undefined): ShownName | null => work
  ? { value: work.title.value, language: work.title.language, direction: work.title.direction } : null;

/**
 * The subject of a Work or Post IRI from what the queue has read so far.
 * A chapter whose own record is not public is
 * still placed in its Book by Main's moderation context (`facts`).
 */
export function subjectOf(iri: string, names: { works: Record<string, WorkSummary>;
  chapters: Record<string, ChapterSummary>; facts?: Record<string, WorkFacts> },
  t: Pick<ContractOf<ManageMessages>, 'workFallback' | 'typeChapter' | 'chapterOf'>): Subject {
  const work = names.works[iri];
  const partOf = names.facts?.[iri]?.partOf ?? null;
  const book = partOf ? names.works[partOf.work] : undefined;
  const chapter = names.chapters[iri];
  // A Post's label belongs to its occurrence; it never borrows a Work title.
  const title = chapter?.label?.value.trim() ? { value: chapter.label.value, language: chapter.label.language,
    direction: chapter.direction } : partOf ? null : named(work);
  const bookName = partOf ? named(book) : null;
  const text = title ? [title.value, bookName?.value].filter(Boolean).join(' · ')
    : partOf ? bookName ? t.chapterOf({ book: bookName.value }) : t.typeChapter : t.workFallback;
  return { iri, work, cover: partOf ? { iri: partOf.work, work: book } : { iri, work }, title, book: bookName, text,
    href: (partOf && chapterPlaceHref(partOf)) || resourceHref('/w/', work && 'address' in work ? work.address as AddressTarget : iri),
    isChapter: partOf !== null, chapter };
}

/** Whether a Work has its own facts to review: a mod's compatibility, a prompt's or a skill's text. */
export function reviewedAs(work: WorkSummary | undefined, facts: WorkFacts | undefined): 'mod' | 'prompt' | 'skill' | null {
  const presentation = work?.types.length ? typeEntry(work.types)?.presentation : undefined;
  if (presentation === 'prompt' || presentation === 'skill') return presentation;
  // The registry does not tell a mod from other installable software; Main's facts carry a mod's compatibility.
  return facts?.mod ? 'mod' : null;
}

/** Whether a Work is read in chapters, so accepting it whole also takes the chapters still to come. */
export const inChapters = (work: WorkSummary | undefined) => !!work && (!!work.chapterCount
  || (work.types.length > 0 && typeEntry(work.types)?.presentation === 'book'));

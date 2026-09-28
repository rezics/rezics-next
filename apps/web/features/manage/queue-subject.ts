import { chapterPlaceHref } from '../work-page/route.ts';
import type { ChapterSummary, WorkSummary } from './types.ts';
import { uuidOf } from './types.ts';

/** A name as the page sets it: its text and, when Main knows it, its language and direction for `lang` and `dir`. */
export interface ShownName { value: string; language?: string; direction?: 'ltr' | 'rtl' }

/**
 * What a queue item or log entry is about, as a moderator recognizes it. A
 * chapter is never a Work of its own here: it is named in its Book
 * ("第一章 雨夜 · 雨夜书店"), wears the Book's cover and opens in the reader at
 * that chapter.
 */
export interface Subject {
  /** The Work the item points at. */
  iri: string;
  /** Its header, when Main named it. */
  work: WorkSummary | undefined;
  /** The Work whose cover is drawn: the Book for a chapter. */
  cover: { iri: string; work: WorkSummary | undefined };
  /** The chapter's label in its Book, or the Work's title; null until Main names it. */
  title: ShownName | null;
  /** The Book a chapter belongs to; null for any other Work. */
  book: ShownName | null;
  /** Both as one line of plain text, for toasts, labels and titles. */
  text: string;
  /** Where to open it: the reader at the chapter, or the Work's page. */
  href: string;
  chapter: ChapterSummary | undefined;
}

const named = (work: WorkSummary | undefined): ShownName | null => work
  ? { value: work.title.value, language: work.title.language, direction: work.title.direction } : null;

/** The subject of a Work IRI from what the queue has read so far; `fallback` names it until Main does. */
export function subjectOf(iri: string, names: { works: Record<string, WorkSummary>;
  chapters: Record<string, ChapterSummary> }, fallback: string): Subject {
  const work = names.works[iri];
  const partOf = work?.partOf ?? null;
  const book = partOf ? names.works[partOf.work] : undefined;
  const chapter = names.chapters[iri];
  // A chapter's own label in its Book's contents; its Work title may still carry the Book's name.
  const title = chapter?.label ? { value: chapter.label.value, language: chapter.label.language,
    direction: chapter.direction } : named(work);
  const bookName = partOf ? named(book) : null;
  const text = [title?.value ?? fallback, bookName?.value].filter(Boolean).join(' · ');
  return { iri, work, cover: partOf ? { iri: partOf.work, work: book } : { iri, work }, title, book: bookName, text,
    href: (partOf && chapterPlaceHref(partOf)) || `/w/${uuidOf(iri)}`, chapter };
}

const vocabulary = 'https://rezics.com/vocab/';

/** Whether a Work has its own facts to review: a mod's compatibility, a prompt's or a skill's text. */
export function reviewedAs(work: WorkSummary | undefined): 'mod' | 'prompt' | 'skill' | null {
  const types = work?.types ?? [];
  if (types.includes(`${vocabulary}PromptTemplate`)) return 'prompt';
  if (types.includes(`${vocabulary}SkillPackage`)) return 'skill';
  return types.includes(`${vocabulary}ModPackage`) ? 'mod' : null;
}

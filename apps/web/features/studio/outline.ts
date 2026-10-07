import type { AgentOption } from '../auth/acting-identity.ts';
import type { CompositionOperation } from './content-api.ts';
import type { ContentsItem, ContentsPage, MainClient } from './types.ts';
import { idOf } from './types.ts';

// A Book's outline as Studio manages it: the top level (chapters, volumes,
// parts and extras) and each group's chapters, one level per Main read. The
// functions here are pure, so stories, tests and the page share them.

export type ChapterState = 'empty' | 'draft' | 'published' | 'changed';
/** Who writes a chapter, of the identities this person acts as. */
export type ChapterWriter = { kind: 'self' } | { kind: 'agent'; agent: AgentOption }
  | { kind: 'external'; iri: string } | { kind: 'unknown' };
export type ChapterAuthor = { kind: 'self' } | { kind: 'agent'; agent: AgentOption } | { kind: 'unknown' };
/** How long a chapter is, in the unit its language's writers count. */
export interface ChapterLength { unit: 'characters' | 'words'; value: number }

export interface ChapterFact {
  writer: ChapterWriter;
  /** Main's current authoring subject, independent of the original writer and private read grants. */
  author: ChapterAuthor;
  /** Where the chapter stands for its writer, from its Content variants; null when Main didn't say. */
  state: ChapterState | null;
  /** The chapter and its title as its writer sees them, when the Studio Agent can't see them. */
  target?: string;
  label?: ContentsItem['label'];
  /** Its length as Main measured the writer's text; absent when Main could not say. */
  length?: ChapterLength;
}

/** What Studio learned about each chapter on a page, by occurrence. */
export type ChapterFacts = Record<string, ChapterFact>;

/** Main's Studio chapter facts, as `GET /v1/me/agents/{agent}/works/{id}/chapters` returns them. */
export type StudioChapterRead = NonNullable<Awaited<ReturnType<ReturnType<ReturnType<
  MainClient['v1']['me']['agents']>['works']>['chapters']['get']>>['data']>;
export type RawFact = StudioChapterRead['facts'][number];

/** Names each chapter's writer from this person's identities, and keeps what only its writer could see. */
export function chapterFacts(agent: AgentOption, agents: readonly AgentOption[], page: ContentsPage | null,
  facts: readonly RawFact[]): ChapterFacts {
  return Object.fromEntries(facts.map(fact => {
    const other = agents.find(option => option.iri === fact.writer && option.iri !== agent.iri);
    const writer: ChapterWriter = fact.writer === agent.iri ? { kind: 'self' }
      : other ? { kind: 'agent', agent: other }
        : fact.writer ? { kind: 'external', iri: fact.writer } : { kind: 'unknown' };
    const subject = agents.find(option => option.iri === fact.authoringSubject);
    const author: ChapterAuthor = fact.authoringSubject === agent.iri ? { kind: 'self' }
      : subject ? { kind: 'agent', agent: subject } : { kind: 'unknown' };
    const hidden = page !== null && !page.items.find(item => item.occurrence === fact.occurrence)?.target;
    return [fact.occurrence, { writer, author, state: fact.state,
      ...(hidden && fact.target ? { target: fact.target } : {}),
      ...(hidden && fact.label ? { label: fact.label } : {}),
      ...(fact.length ? { length: fact.length } : {}) }];
  }));
}

/** Publish only as Main's current authoring subject, never from provenance or a private read grant. */
export const publishable = (fact: ChapterFact | undefined) => fact?.author.kind === 'self'
  && (fact.state === 'draft' || fact.state === 'changed');

/** The groups a chapter can move into, in reading order. */
export const groupsOf = (top: readonly ContentsItem[]) => top.filter(item => item.role === 'group');

/**
 * Where a use goes: first or after a sibling in its new level, or the end of a
 * group. Siblings are the loaded items of that level; the moving use is never
 * its own anchor.
 */
export type Destination =
  | { parent: string; before: string }
  | { parent: string; after: string }
  | { parent: string; end: true };

/** The composition operation that puts `occurrence` at `destination` in a level whose loaded items are `siblings`. */
export function moveOperation(occurrence: string, destination: Destination, siblings: readonly ContentsItem[]):
  CompositionOperation {
  const others = siblings.filter(item => item.occurrence !== occurrence);
  const position = 'end' in destination ? 'last' as const
    : 'after' in destination ? { after: destination.after }
      : (() => {
        const index = others.findIndex(item => item.occurrence === destination.before);
        return index > 0 ? { after: others[index - 1]!.occurrence } : 'first' as const;
      })();
  return { op: 'move', occurrence, parent: destination.parent, position };
}

/** One step up or down within the loaded level; null at its edge. */
export function stepDestination(occurrence: string, direction: -1 | 1, parent: string,
  siblings: readonly ContentsItem[]): Destination | null {
  const index = siblings.findIndex(item => item.occurrence === occurrence);
  const neighbour = siblings[index + direction];
  if (index < 0 || !neighbour) return null;
  return direction === -1 ? { parent, before: neighbour.occurrence } : { parent, after: neighbour.occurrence };
}

/** Which half of a row a pointer is over, for a drop before or after it. */
export const dropEdge = (clientY: number, rect: { top: number; height: number }): 'before' | 'after' =>
  clientY < rect.top + rect.height / 2 ? 'before' : 'after';

/** The default level a new chapter goes to: the last volume or part (never extras), else the top level. */
export function defaultChapterParent(structure: string, top: readonly ContentsItem[]): string {
  const story = groupsOf(top).filter(item => item.division !== 'extras');
  return story.at(-1)?.occurrence ?? structure;
}

/** A stable short ID for an occurrence in DOM ids and keys. */
export const shortOf = (occurrence: string) => idOf(occurrence);

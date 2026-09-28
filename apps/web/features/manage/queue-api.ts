import { browserMainApi } from '../api/browser.ts';
import { commitDecision, type Outcome } from './commands.ts';
import type { Decision } from './queue-state.ts';
import { mergeAgents, readAgents, readDecisionBasis, readDraftText, readQueue, readSubjects } from './read.ts';
import type { QueueView } from './routes.ts';
import type { AgentSummary, ChapterSummary, DecisionBasis, Loaded, MainClient, ModerationItem, ModerationPage,
  PersonRecord, WorkFacts, WorkSummary } from './types.ts';

/**
 * Everything the queue knows about the people and Works its items mention:
 * public names, Work headers with each chapter's Book, chapters' labels and
 * openings, and Main's moderation context (people's records here, authors,
 * mod cards and prompt text). Each part fills in as reads answer.
 */
export interface QueueNames {
  agents: Record<string, AgentSummary>;
  works: Record<string, WorkSummary>;
  chapters: Record<string, ChapterSummary>;
  records: Record<string, PersonRecord>;
  facts: Record<string, WorkFacts>;
}

export const noNames: QueueNames = { agents: {}, works: {}, chapters: {}, records: {}, facts: {} };

/** What the queue needs from Main after the first render. Stories pass a stand-in. */
export interface QueueApi {
  page(view: QueueView, cursor: string | null): Promise<Loaded<ModerationPage>>;
  names(items: readonly ModerationItem[], known: QueueNames): Promise<QueueNames>;
  draft(item: ModerationItem): Promise<Loaded<{ text: string; language: string }>>;
  /** A report's reports, statements and the rules a decision would cite. */
  basis(item: ModerationItem): Promise<Loaded<DecisionBasis>>;
  /** Public names for Agents a basis mentions, such as further reporters. */
  people(iris: readonly string[]): Promise<Record<string, AgentSummary>>;
  commit(item: ModerationItem, decision: Decision, key: string): Promise<Outcome<unknown>>;
}

/** The reporters a report's basis names, so the detail can say who said what. */
export const reporters = (basis: DecisionBasis) => basis.reports.map(report => report.actingSubject);

/** The Agents and Works a page of queue items mentions. */
export function mentioned(items: readonly ModerationItem[]) {
  return { agents: items.flatMap(item => [item.authorAgent, item.escalation?.actingSubject])
    .filter((iri): iri is string => typeof iri === 'string'),
  works: items.filter(item => item.target.owner === 'graph').map(item => item.target.resource) };
}

/** Newly read names over known ones; a part Main could not answer keeps what was known. */
export function mergeNames(known: QueueNames, found: Partial<QueueNames>): QueueNames {
  return { agents: mergeAgents(known.agents, found.agents ?? {}), works: { ...known.works, ...found.works },
    chapters: { ...known.chapters, ...found.chapters }, records: { ...known.records, ...found.records },
    facts: { ...known.facts, ...found.facts } };
}

/**
 * Reads what a page of items mentions: public names, and the Works as a
 * moderator sees them (`readSubjects`), with the records of the people who
 * submitted or reported them. `names` reads public profiles (the server
 * reads them anonymously).
 */
export async function readQueueNames(main: MainClient, realm: string, items: readonly ModerationItem[],
  query: { language: string; actingSubject: string }, known: QueueNames = noNames, names: MainClient = main):
  Promise<QueueNames> {
  const wanted = mentioned(items);
  const people = [...new Set(items.flatMap(item => item.authorAgent ? [item.authorAgent] : []))]
    .filter(iri => !known.records[iri]);
  const [agents, subjects] = await Promise.all([
    readAgents(names, wanted.agents, names === main ? query.actingSubject : undefined),
    readSubjects(main, realm, wanted.works, query, known, people)]);
  return mergeNames(known, { agents, ...subjects });
}

/** The queue through the BFF, acting as `actingSubject`. */
export function bffQueueApi(realm: string, actingSubject: string, language: string): QueueApi {
  return {
    page: (view, cursor) => readQueue(browserMainApi(), realm, { actingSubject, ...view, cursor }),
    names: (items, known) => readQueueNames(browserMainApi(), realm, items, { language, actingSubject }, known),
    // Whole-Work and publication submissions carry no contribution draft to read.
    draft: item => item.submission?.contribution && item.submission.selectedDraft
      ? readDraftText(browserMainApi(), item.submission.contribution, item.submission.selectedDraft, actingSubject)
      : Promise.resolve({ ok: false, failure: 'missing' }),
    basis: item => readDecisionBasis(browserMainApi(), realm, item.id, actingSubject),
    people: iris => readAgents(browserMainApi(), iris, actingSubject),
    commit: (item, decision, key) => commitDecision(browserMainApi(), realm, item, decision, actingSubject, key),
  };
}

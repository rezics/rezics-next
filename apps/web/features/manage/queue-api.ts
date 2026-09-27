import { browserMainApi } from '../api/browser.ts';
import { commitDecision, type Outcome } from './commands.ts';
import type { Decision } from './queue-state.ts';
import { readAgents, readDraftText, readQueue, readWorks } from './read.ts';
import type { QueueView } from './routes.ts';
import type { AgentSummary, Loaded, ModerationItem, ModerationPage, WorkSummary } from './types.ts';

/** What the queue needs from Main after the first render. Stories pass a stand-in. */
export interface QueueApi {
  page(view: QueueView, cursor: string | null): Promise<Loaded<ModerationPage>>;
  names(items: readonly ModerationItem[]): Promise<{ agents: Record<string, AgentSummary>;
    works: Record<string, WorkSummary> }>;
  draft(item: ModerationItem): Promise<Loaded<{ text: string; language: string }>>;
  commit(item: ModerationItem, decision: Decision, key: string): Promise<Outcome<unknown>>;
}

/** The Agents and Works a page of queue items mentions. */
export function mentioned(items: readonly ModerationItem[]) {
  return { agents: items.flatMap(item => [item.authorAgent, item.escalation?.actingSubject])
    .filter((iri): iri is string => typeof iri === 'string'),
  works: items.filter(item => item.target.owner === 'graph').map(item => item.target.resource) };
}

/** The queue through the BFF, acting as `actingSubject`. */
export function bffQueueApi(realm: string, actingSubject: string, language: string): QueueApi {
  return {
    page: (view, cursor) => readQueue(browserMainApi(), realm, { actingSubject, ...view, cursor }),
    async names(items) {
      const main = browserMainApi();
      const { agents, works } = mentioned(items);
      const [agentNames, workNames] = await Promise.all([readAgents(main, agents),
        readWorks(main, works, { language, actingSubject })]);
      return { agents: agentNames, works: workNames };
    },
    draft: item => item.submission
      ? readDraftText(browserMainApi(), item.submission.contribution, item.submission.selectedDraft, actingSubject)
      : Promise.resolve({ ok: false, failure: 'missing' }),
    commit: (item, decision, key) => commitDecision(browserMainApi(), realm, item, decision, actingSubject, key),
  };
}

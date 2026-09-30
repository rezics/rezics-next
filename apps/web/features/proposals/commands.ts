import { browserMainApi } from '../api/browser.ts';
import { commandFailure, type CommandFailure, newKey } from '../manage/commands.ts';
import { problemCode } from '../manage/types.ts';
import { settle } from '../feed/types.ts';
import { type ActionRequest, operationOf } from './actions.ts';
import { blockerOf } from './blockers.ts';
import { readHeaderState, readProposals, readTargetNames } from './read.ts';
import type { BaseHead, Blocker, CommandResult, Evidence, HeaderState, Loaded, MainClient, ProposalFilter, ProposalPage, ProposalRead,
  TargetName } from './types.ts';

// Commands from the browser through the BFF. Each intent carries one
// Idempotency-Key, so a retry after a lost response replays the same receipt.
// Outcomes are data, never exceptions, and a refusal keeps Main's typed blocker.

export { newKey };
export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: CommandFailure; blocker?: Blocker; code?: string };

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

export async function send<T>(call: () => Promise<Answer<T>>): Promise<Outcome<T>> {
  try {
    const { data, error } = await call();
    if (error) {
      const code = problemCode(error.value);
      const blocker = blockerOf(error.value);
      return { ok: false, failure: commandFailure(error.status, code), ...code ? { code } : {}, ...blocker ? { blocker } : {} };
    }
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

const keyed = (key: string) => ({ headers: { 'idempotency-key': key } });

export interface Correction { kind: string; target: { resource: string; revision: string; context: string };
  candidate: unknown; baseHeads: BaseHead[]; evidence: Evidence[] }

/** Opens a proposal: G-865's create. */
export function createProposal(main: MainClient, correction: Correction, actingSubject: string, key: string):
  Promise<Outcome<CommandResult>> {
  return send(() => main.v1.editorial.proposals.post({ profile: 'editorial-proposal-create-v1', ...correction,
    actingSubject }, keyed(key)));
}

/** A new revision of the proposal's candidate: G-865's revise. */
export function reviseProposal(main: MainClient, proposal: string, revision: number,
  correction: Pick<Correction, 'candidate' | 'baseHeads' | 'evidence'>, actingSubject: string, key: string):
  Promise<Outcome<CommandResult>> {
  return send(() => main.v1.editorial.proposals({ proposal }).revisions.post({ profile: 'editorial-proposal-revise-v1',
    revision, ...correction, actingSubject }, keyed(key)));
}

/** One action on a proposal. Each request is exactly one operation, `operationOf`. */
export function act(main: MainClient, proposal: string, request: ActionRequest, actingSubject: string, key: string):
  Promise<Outcome<unknown>> {
  const one = main.v1.editorial.proposals({ proposal });
  switch (request.kind) {
    case 'review': return send(() => one.reviews.post({ profile: 'editorial-proposal-review-v1',
      revision: request.revision, outcome: request.outcome, message: request.message, actingSubject }, keyed(key)));
    case 'decide': return send(() => one.decisions.post({ profile: 'editorial-proposal-decide-v1',
      revision: request.revision, outcome: request.outcome, approve: request.approve, message: request.message,
      actingSubject }, keyed(key)));
    case 'withdraw': return send(() => one.withdrawal.post({ profile: 'editorial-proposal-withdraw-v1',
      revision: request.revision, actingSubject }, keyed(key)));
    case 'revert': return send(() => one.reversal.post({ profile: 'editorial-proposal-revert-v1',
      evidence: request.evidence, actingSubject }, keyed(key)));
    case 'recover': return send(() => one.recovery.post({ profile: 'editorial-proposal-recover-v1', actingSubject }));
  }
}

/** What the proposal page and list need from Main after the first render. Stories pass a stand-in. */
export interface ProposalApi {
  read(proposal: string): Promise<Loaded<ProposalRead>>;
  act(request: ActionRequest, key: string): Promise<Outcome<unknown>>;
  revise(revision: number, correction: Pick<Correction, 'candidate' | 'baseHeads' | 'evidence'>, key: string):
    Promise<Outcome<CommandResult>>;
  /** The Work's header as its owner reads it now, for rebasing a revision the owner refused as stale. */
  current(work: string): Promise<Loaded<{ state: HeaderState; head: string | null }>>;
  /** The next page of the timeline. */
  more(cursor: string): Promise<Loaded<ProposalRead>>;
}

export interface ListApi {
  page(filter: Exclude<ProposalFilter, 'target'>, cursor: string | null): Promise<Loaded<ProposalPage>>;
  names(resources: readonly string[]): Promise<Record<string, TargetName>>;
}

export const operationsOf = (requests: readonly ActionRequest[]) => requests.map(operationOf);

/** The proposal through the BFF, acting as `actingSubject`. */
export function bffProposalApi(proposal: string, actingSubject: string | undefined): ProposalApi {
  const read = (cursor?: string) => settle(() => browserMainApi().v1.editorial.proposals({ proposal }).get({
    query: { ...actingSubject ? { actingSubject } : {}, ...cursor ? { cursor } : {} } }));
  return {
    read: () => read(),
    more: cursor => read(cursor),
    current: work => readHeaderState(browserMainApi(), work, actingSubject),
    // Without an Agent nothing is allowed, so nothing is sent.
    act: (request, key) => actingSubject ? act(browserMainApi(), proposal, request, actingSubject, key)
      : Promise.resolve({ ok: false, failure: 'sign-in' }),
    revise: (revision, correction, key) => actingSubject ? reviseProposal(browserMainApi(), proposal, revision,
      correction, actingSubject, key) : Promise.resolve({ ok: false, failure: 'sign-in' }),
  };
}

export function bffListApi(actingSubject: string, language: string): ListApi {
  return {
    page: (filter, cursor) => readProposals(browserMainApi(), filter, actingSubject, cursor),
    names: resources => readTargetNames(browserMainApi(), actingSubject, resources, language),
  };
}

/** Opening a proposal through the BFF, acting as `actingSubject`. */
export const bffCreate = (actingSubject: string): CreateApi => (correction, key) =>
  createProposal(browserMainApi(), correction, actingSubject, key);
export type CreateApi = (correction: Correction, key: string) => Promise<Outcome<CommandResult>>;

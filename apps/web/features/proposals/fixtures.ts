import type { ActionRequest } from './actions.ts';
import type { ListApi, Outcome, ProposalApi } from './commands.ts';
import type { AllowedAction, Blocker, CorrectionBasis, HeaderState, ProposalRead, ProposalState, TargetName }
  from './types.ts';
import type { Agents } from './parts.tsx';

const iri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ids = { work: iri(100), workRevision: iri(101), proposal: '00000000-0000-4000-8000-000000000201',
  reverting: '00000000-0000-4000-8000-000000000202', member: iri(301), steward: iri(302), other: iri(303) };
export const now = Date.parse('2026-10-01T09:00:00.000Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const target: TargetName = { value: '雨夜书店', language: 'zh-Hans' };
export const agents: Agents = {
  [ids.member]: { iri: ids.member, label: '林小雨', handle: 'xiaoyu' },
  [ids.steward]: { iri: ids.steward, label: 'Daniel Chen', handle: 'dchen' },
  [ids.other]: { iri: ids.other, label: null, handle: null },
};

const component = 'urn:rezics:work-metadata:9b4f';
export const headerBefore: HeaderState = { kind: 'header', originalTitle: { value: '雨夜书店', language: 'zh-Hans' },
  completionStatus: 'ongoing', localized: [
    { language: 'en', title: 'The Rainy Night Bookshop', description: 'A bookshop opens only when it rains.',
      mainVersionLabel: null, tagline: null },
    { language: 'zh-Hant', title: '雨夜書店', description: '一間只在下雨時開門的書店。', mainVersionLabel: null,
      tagline: null }] };
export const headerAfter: HeaderState = { ...headerBefore, localized: [headerBefore.localized[0]!,
  { ...headerBefore.localized[1]!,
    description: '一間只在雨夜開門的書店，店主收集人們沒寄出的信。' }] };

export const basis: CorrectionBasis = { target: { resource: ids.work, revision: ids.workRevision,
  context: 'urn:rezics:context:global' }, baseHeads: [{ component, head: iri(401) }], state: headerBefore,
name: { value: '雨夜书店', language: 'zh-Hans' } };

const candidate = (state: HeaderState) => ({ command: 'work-metadata', state });
const source = { resource: 'https://example.com/books/rainy-night', revision: 'retrieved:2026-09-30',
  locator: 'Back cover' };

/** A proposal read as the API returns it; each story overrides what it is about. */
export function proposalView(state: ProposalState, allowedActions: AllowedAction[], rest: Partial<ProposalRead> = {}):
  ProposalRead {
  return { profile: 'editorial-proposal-v1',
    proposal: { id: ids.proposal, kind: 'component-correction', target: { resource: ids.work, revision: ids.workRevision,
      context: 'urn:rezics:context:global', work: ids.work }, proposer: ids.member, latestRevision: 2,
    decision: null, reverts: null },
    revision: { proposal: ids.proposal, n: 2, candidate: candidate(headerAfter), candidateDigest: 'abc', before: candidate(headerBefore),
      baseHeads: [{ component, head: iri(401) }], evidence: [source] },
    preview: [{ path: 'localized', before: headerBefore.localized, after: headerAfter.localized }],
    state, approvalIds: [], staleApprovalIds: [], staleApprovalIdsComplete: true, blockers: [], allowedActions,
    timeline: [
      { sequence: '1', kind: 'created', actor: ids.member, revision: 1, occurredAt: at(300), review: null },
      { sequence: '2', kind: 'reviewed', actor: ids.steward, revision: 1, occurredAt: at(200),
        review: { id: ids.other.slice(-36), outcome: 'request_changes', message: 'Please cite where the synopsis was printed.' } },
      { sequence: '3', kind: 'revised', actor: ids.member, revision: 2, occurredAt: at(60), review: null }],
    nextCursor: null, ...rest };
}

const applied = { proposal: ids.proposal, revision: 2, actor: ids.steward, outcome: 'applied' as const,
  receipt: null, reverts: null };
const staleBase: Blocker = { code: 'stale_base', expectedHeads: [{ component, head: iri(401) }],
  actualHeads: [{ component, head: iri(402) }] };

export const views = {
  open: proposalView('open', ['review', 'approve-and-apply', 'reject']),
  proposer: proposalView('changes_requested', ['revise', 'withdraw']),
  staleBase: proposalView('open', ['revise', 'withdraw'], { blockers: [staleBase] }),
  staleApproval: proposalView('open', ['review', 'approve-and-apply'], { staleApprovalIds: [ids.other.slice(-36)],
    blockers: [{ code: 'required_approvals', required: 1, received: 0 }] }),
  applied: proposalView('applied', ['revert'], { proposal: { ...proposalView('applied', []).proposal, decision: applied },
    blockers: [{ code: 'terminal_decision', outcome: 'applied' }] }),
  reverted: proposalView('applied', [], { proposal: { ...proposalView('applied', []).proposal, id: ids.reverting,
    reverts: ids.proposal, decision: { ...applied, proposal: ids.reverting } },
  blockers: [{ code: 'terminal_decision', outcome: 'applied' }] }),
  withdrawn: proposalView('withdrawn', [], { proposal: { ...proposalView('withdrawn', []).proposal,
    decision: { ...applied, outcome: 'withdrawn', actor: ids.member } },
  blockers: [{ code: 'terminal_decision', outcome: 'withdrawn' }] }),
  forbidden: proposalView('open', [], { blockers: [{ code: 'review_authority_required' }] }),
  pending: proposalView('approved', ['recover'], { blockers: [{ code: 'apply_pending', operationKey: 'editorial:x:2' }] }),
} satisfies Record<string, ProposalRead>;

/** A stand-in for Main: records each request, answers with `next`, and reads back `view`. */
export function proposalApi(view: ProposalRead, next: ProposalRead = view,
  reply: Outcome<unknown> = { ok: true, data: { proposal: ids.reverting } }): ProposalApi & { sent: ActionRequest[] } {
  const sent: ActionRequest[] = [];
  let current = view;
  return { sent,
    read: () => Promise.resolve({ ok: true, data: current }),
    more: () => Promise.resolve({ ok: true, data: view }),
    act: request => { sent.push(request); if (reply.ok) current = next; return Promise.resolve(reply); },
    revise: () => { current = next; return Promise.resolve({ ok: true, data: { profile: 'editorial-command-v1',
      proposal: ids.proposal, revision: 3, outcome: 'revised', replayed: false } }); },
  };
}

export const listPage = { items: [
  { id: ids.proposal, kind: 'component-correction', target: { resource: ids.work, revision: ids.workRevision,
    context: 'urn:rezics:context:global', work: ids.work } },
  { id: ids.reverting, kind: 'component-correction', target: { resource: iri(102), revision: iri(103),
    context: 'urn:rezics:context:global', work: iri(102) } }],
nextCursor: null };
export const listNames: Record<string, TargetName> = { [ids.work]: target,
  [iri(102)]: { value: 'The Library at Mount Char', language: 'en' } };
export const listApi: ListApi = { page: () => Promise.resolve({ ok: true, data: listPage }),
  names: () => Promise.resolve(listNames) };

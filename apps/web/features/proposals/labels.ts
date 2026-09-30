import type { CommandFailure } from '../manage/commands.ts';
import type { ProposalMessages } from './messages.ts';
import type { ProposalState, TimelineEntry } from './types.ts';

export const stateKey = { open: 'stateOpen', changes_requested: 'stateChangesRequested', approved: 'stateApproved',
  applied: 'stateApplied', rejected: 'stateRejected', withdrawn: 'stateWithdrawn',
} as const satisfies Record<ProposalState, keyof ProposalMessages>;

/** How a state reads: settled ones are quiet, the one waiting on the viewer stands out. */
export const stateTone = { open: 'info', changes_requested: 'warning', approved: 'info', applied: 'success',
  rejected: 'secondary', withdrawn: 'secondary' } as const satisfies Record<ProposalState, string>;

export const failureKey = { stale: 'failStale', conflict: 'failConflict', denied: 'failDenied', invalid: 'failInvalid',
  missing: 'failMissing', 'sign-in': 'failSignIn', budget: 'failBudget', pending: 'failPending',
  unavailable: 'failUnavailable',
} as const satisfies Record<CommandFailure, keyof ProposalMessages>;

export const kindLabelKey = { 'component-correction': 'kindComponentCorrection' } as const;

/** A kind's label, or its own words when this page has none: new kinds need no UI work. */
export function kindLabel(kind: string, t: Record<string, unknown>): string {
  const key = (kindLabelKey as Record<string, string>)[kind];
  const text = key ? t[key] : undefined;
  if (typeof text === 'string') return text;
  const words = kind.replace(/-/g, ' ');
  return words[0]!.toUpperCase() + words.slice(1);
}

/** The message for a timeline step (the event kinds of `editorial-review/store.ts`). */
export const eventKey = { created: 'eventCreated', revised: 'eventRevised', 'reversal-proposed': 'eventReversal',
  reviewed: 'eventReviewed', applied: 'eventApplied', rejected: 'eventRejected', withdrawn: 'eventWithdrawn',
  'apply-pending': 'eventPending', 'apply-stale': 'eventStale', 'apply-cancelled': 'eventCancelled',
} as const;

export const eventMessage = (entry: Pick<TimelineEntry, 'kind'>) =>
  (eventKey as Record<string, string>)[entry.kind] ?? 'eventOther';

export const reviewKey = { approve: 'reviewApprove', request_changes: 'reviewChanges', comment: 'reviewComment' } as const;

export const factKey = { title: 'factTitle', description: 'factDescription', tagline: 'factTagline',
  mainVersionLabel: 'factMainVersionLabel', originalTitle: 'factOriginalTitle', completionStatus: 'factCompletionStatus',
  value: 'factValue' } as const;

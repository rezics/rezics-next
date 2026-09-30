import type { AllowedAction, ReviewOutcome } from './types.ts';

/**
 * What a control asks Main for. Each request is exactly one G-865 operation
 * (`operationOf`), so the page decides nothing: it offers a control for each of
 * the `allowedActions` the read returned and sends what the person chose.
 */
export type ActionRequest =
  | { kind: 'review'; revision: number; outcome: ReviewOutcome; message: string }
  | { kind: 'decide'; revision: number; outcome: 'applied' | 'rejected'; approve: boolean; message: string }
  | { kind: 'withdraw'; revision: number }
  | { kind: 'revert'; evidence: { resource: string; revision: string; locator: string | null }[] }
  | { kind: 'recover' };

/** The operations of `routes/editorial-proposals.ts` a control can call. */
export type Operation = 'review' | 'decide' | 'withdraw' | 'revert' | 'recover' | 'revise';

export const operationOf = (request: ActionRequest): Operation => request.kind === 'decide' ? 'decide' : request.kind;

/** A control the page offers, tied to the `allowedActions` entry that lets it appear. */
export interface Control {
  action: AllowedAction;
  /** Whether it opens a dialog (a message or evidence is needed) or sends at once. */
  opens: 'dialog' | 'now';
  /** The operation it calls when sent. */
  operation: Operation;
  tone: 'primary' | 'secondary' | 'destructive';
}

const controls: Record<AllowedAction, Omit<Control, 'action'>> = {
  'approve-and-apply': { opens: 'dialog', operation: 'decide', tone: 'primary' },
  apply: { opens: 'dialog', operation: 'decide', tone: 'primary' },
  review: { opens: 'dialog', operation: 'review', tone: 'secondary' },
  reject: { opens: 'dialog', operation: 'decide', tone: 'destructive' },
  revise: { opens: 'dialog', operation: 'revise', tone: 'secondary' },
  withdraw: { opens: 'dialog', operation: 'withdraw', tone: 'secondary' },
  revert: { opens: 'dialog', operation: 'revert', tone: 'secondary' },
  recover: { opens: 'now', operation: 'recover', tone: 'secondary' },
};

/** The order controls appear in: the main step first, the exits last. */
const order: readonly AllowedAction[] = ['approve-and-apply', 'apply', 'review', 'revise', 'recover', 'revert',
  'reject', 'withdraw'];

/** One control for each allowed action, never for one the read did not list. */
export function controlsFor(allowed: readonly AllowedAction[]): Control[] {
  return order.filter(action => allowed.includes(action)).map(action => ({ action, ...controls[action] }));
}

/** The decision an apply, approve-and-apply or reject control sends. */
export function decisionOf(action: Extract<AllowedAction, 'apply' | 'approve-and-apply' | 'reject'>):
  { outcome: 'applied' | 'rejected'; approve: boolean } {
  return action === 'reject' ? { outcome: 'rejected', approve: false }
    : { outcome: 'applied', approve: action === 'approve-and-apply' };
}

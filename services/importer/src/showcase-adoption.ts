import { showcaseDigest, type ShowcaseReviewPort } from './showcase-contract.ts';
import type { ShowcaseJournal, ShowcaseJournalActionRow } from './showcase-journal.ts';
import { sameAdoptionSelection, type AdoptionSnapshot } from './showcase-current-reads.ts';
import {
  showcaseAdoptInvocationBound,
  type ShowcaseAdoptBody,
} from './showcase-publication-contract.ts';
export { showcaseAdoptInvocationBound } from './showcase-publication-contract.ts';

export function showcaseReviewActionKey(kind: 'accept' | 'adopt', identity: string, digest: string): string {
  return `${kind}:${showcaseDigest({ identity, digest })}`;
}

export function actionIdempotencyKey(action: string, body: unknown): string {
  return showcaseDigest({ action, body });
}

export function showcaseAdoptIdentity(subjectId: string, property: string, intent: string): string {
  return `${subjectId}:${property}:${intent}`;
}

export function showcaseAdoptGenerationKey(
  subjectId: string,
  property: string,
  intent: string,
  generation: number,
): string {
  return showcaseReviewActionKey(
    'adopt',
    `${subjectId}:${property}`,
    showcaseDigest({ intent, generation }),
  );
}

export type ShowcaseActionRefusalDisposition = 'retry' | 'stale' | 'refused';
export type ShowcaseActionSendResult<Receipt> =
  | { status: 'sent'; receipt: Receipt }
  | { status: 'acknowledged' }
  | { status: 'stale' | 'refused'; code: string; error?: unknown };

/** Persist, replay and settle exact review action bodies through the shared local journal. */
export async function sendSealedShowcaseAction<Receipt>(input: {
  journal: ShowcaseJournal;
  action: string;
  body: unknown;
  send: (sealedBody: unknown, sealedKey: string) => Promise<Receipt>;
  refusalDisposition: (code: string | null | undefined) => ShowcaseActionRefusalDisposition;
}): Promise<ShowcaseActionSendResult<Receipt>> {
  const existing = input.journal.action(input.action);
  if (existing?.state === 'acknowledged') return { status: 'acknowledged' };
  if (existing?.state === 'refused') {
    const disposition = input.refusalDisposition(existing.error_code);
    if (disposition === 'refused') return { status: disposition, code: existing.error_code ?? 'review-refused' };
  }

  const sealedBody = input.journal.prepareAction(
    input.action,
    input.body,
    actionIdempotencyKey(input.action, input.body),
  );
  const sealed = input.journal.action(input.action)!;
  if (sealed.state === 'acknowledged') return { status: 'acknowledged' };
  if (sealed.state === 'refused') {
    const disposition = input.refusalDisposition(sealed.error_code);
    if (disposition !== 'retry') return { status: disposition, code: sealed.error_code ?? 'review-refused' };
  }
  try {
    const receipt = await input.send(sealedBody, sealed.idempotency_key);
    input.journal.acknowledgeAction(input.action);
    return { status: 'sent', receipt };
  } catch (error) {
    const code = errorCode(error);
    const disposition = input.refusalDisposition(code);
    if (disposition === 'retry') throw error;
    input.journal.refuseAction(input.action, code);
    return { status: disposition, code, error };
  }
}

type AdoptBody = ShowcaseAdoptBody;

function sealedAdoptBody(value: unknown): AdoptBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    body.mode !== 'replace' ||
    typeof body.property !== 'string' ||
    typeof body.context !== 'string' ||
    !Array.isArray(body.selection)
  )
    return null;
  const expected_head =
    typeof body.expected_head === 'number' && Number.isSafeInteger(body.expected_head) ? body.expected_head : null;
  const selection = body.selection.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.candidate !== 'string' || (item.rank !== 'normal' && item.rank !== 'preferred')) return [];
    return [{ candidate: item.candidate, rank: item.rank as 'normal' | 'preferred' }];
  });
  return { context: body.context, property: body.property, mode: 'replace', expected_head, selection };
}

function generationAdoptKey(subjectId: string, property: string, intent: string, generation: number): string {
  return showcaseAdoptGenerationKey(subjectId, property, intent, generation);
}

function legacyAdoptKey(subjectId: string, property: string, intent: string): string {
  return showcaseReviewActionKey('adopt', `${subjectId}:${property}`, showcaseDigest({ intent }));
}

function previousBodyAdoptKey(subjectId: string, property: string, intent: string, body: unknown): string {
  return showcaseReviewActionKey('adopt', `${subjectId}:${property}`, showcaseDigest({ intent, body }));
}

function previousFormatPreparedKeys(
  journal: ShowcaseJournal,
  subjectId: string,
  property: string,
  intent: string,
  identity: string,
): string[] {
  const found: string[] = [];
  const consider = (prior: ShowcaseJournalActionRow) => {
    const body = JSON.parse(prior.body_json) as unknown;
    if (prior.action_key === previousBodyAdoptKey(subjectId, property, intent, body)) found.push(prior.action_key);
  };
  for (const prior of journal.pendingAdoptActions(identity)) consider(prior);
  if (found.length) return found;
  let after = '';
  for (;;) {
    const rows = journal.preparedAdoptPage(after);
    if (!rows.length) break;
    for (const prior of rows) consider(prior);
    if (found.length) break;
    if (rows.length < showcaseAdoptInvocationBound) break;
    after = rows.at(-1)!.action_key;
  }
  return found;
}

/** Identity-bound resume keys: pending originals first, then previous-format, then a bounded generation window. */
export function adoptResumeKeys(
  journal: ShowcaseJournal,
  subjectId: string,
  property: string,
  intent: string,
  planned: unknown,
): string[] {
  const identity = showcaseAdoptIdentity(subjectId, property, intent);
  const keys = [
    previousBodyAdoptKey(subjectId, property, intent, planned),
    ...journal.pendingAdoptActions(identity).map((row) => row.action_key),
    ...previousFormatPreparedKeys(journal, subjectId, property, intent, identity),
    legacyAdoptKey(subjectId, property, intent),
  ];
  for (let generation = 0; generation < showcaseAdoptInvocationBound; generation += 1)
    keys.push(generationAdoptKey(subjectId, property, intent, generation));
  const recorded = journal.adoptGeneration(identity);
  if (recorded > showcaseAdoptInvocationBound) {
    const from = Math.max(showcaseAdoptInvocationBound, recorded - showcaseAdoptInvocationBound);
    for (let generation = from; generation < recorded; generation += 1)
      keys.push(generationAdoptKey(subjectId, property, intent, generation));
  }
  return [...new Set(keys)];
}

function nextFreshAdoptAction(
  journal: ShowcaseJournal,
  subjectId: string,
  property: string,
  intent: string,
): string | null {
  const identity = showcaseAdoptIdentity(subjectId, property, intent);
  for (const candidate of adoptResumeKeys(journal, subjectId, property, intent, { identity })) {
    const prior = journal.action(candidate);
    if (prior?.state === 'prepared') return candidate;
  }
  for (let generation = 0; generation < showcaseAdoptInvocationBound; generation += 1) {
    const action = generationAdoptKey(subjectId, property, intent, generation);
    if (!journal.action(action)) return action;
  }
  const recorded = journal.adoptGeneration(identity);
  const start = Math.max(showcaseAdoptInvocationBound, recorded);
  for (let generation = showcaseAdoptInvocationBound; generation < start; generation += 1) {
    const action = generationAdoptKey(subjectId, property, intent, generation);
    if (journal.action(action)?.state === 'prepared') return action;
  }
  let generation = start;
  for (let step = 0; step < showcaseAdoptInvocationBound; step += 1) {
    const action = generationAdoptKey(subjectId, property, intent, generation);
    const prior = journal.action(action);
    if (prior?.state === 'prepared') return action;
    if (!prior) {
      journal.advanceAdoptGeneration(identity, generation + 1);
      return action;
    }
    generation += 1;
  }
  return null;
}

export async function sendDurableAdopt(input: {
  journal: ShowcaseJournal;
  review: Pick<ShowcaseReviewPort, 'adoptReviewedCandidates'>;
  subjectId: string;
  intent: string;
  planned: AdoptBody;
  current: { selection: readonly { candidate: string; rank: string }[] } | null;
}): Promise<
  | { status: 'complete'; snapshot?: AdoptionSnapshot }
  | { status: 'refused'; code: string }
  | { status: 'interrupted'; code: string }
  | { status: 'bound' }
> {
  const identity = showcaseAdoptIdentity(input.subjectId, input.planned.property, input.intent);
  for (let step = 0; step < showcaseAdoptInvocationBound; step += 1) {
    const keys = adoptResumeKeys(input.journal, input.subjectId, input.planned.property, input.intent, input.planned);
    let action = '';
    let body = input.planned;
    let found = false;
    for (const candidate of keys) {
      const prior = input.journal.action(candidate);
      if (prior?.state !== 'prepared') continue;
      const sealed = sealedAdoptBody(JSON.parse(prior.body_json));
      if (!sealed) throw new TypeError('Prepared showcase adopt body is invalid');
      action = candidate;
      body = sealed;
      found = true;
      break;
    }
    if (!found) {
      for (const candidate of keys) {
        const prior = input.journal.action(candidate);
        if (prior?.state === 'refused' && permanentReviewRefusal(prior.error_code))
          return { status: 'refused', code: prior.error_code! };
        if (prior?.state !== 'acknowledged') continue;
        const sealed = sealedAdoptBody(JSON.parse(prior.body_json));
        if (
          sealed &&
          sameAdoptionSelection(sealed.selection, input.planned.selection) &&
          input.current &&
          sameAdoptionSelection(input.current.selection, input.planned.selection)
        )
          return { status: 'complete' };
      }
      if (input.current && sameAdoptionSelection(input.current.selection, input.planned.selection))
        return { status: 'complete' };
      const fresh = nextFreshAdoptAction(input.journal, input.subjectId, input.planned.property, input.intent);
      if (fresh) {
        action = fresh;
        body = input.planned;
        found = true;
      }
    }
    if (!found) return { status: 'bound' };
    input.journal.recordPendingAdopt(identity, action);
    try {
      const sent = await sendSealedShowcaseAction({
        journal: input.journal,
        action,
        body,
        refusalDisposition: (code) => (permanentReviewRefusal(code) ? 'refused' : 'retry'),
        send: (sealedBody, sealedKey) =>
          input.review.adoptReviewedCandidates(input.subjectId, sealedBody as AdoptBody, sealedKey),
      });
      if (sent.status === 'refused') return { status: 'refused', code: sent.code };
      if (sent.status === 'stale') return { status: 'interrupted', code: sent.code };
      if (sent.status === 'acknowledged') {
        if (!sameAdoptionSelection(body.selection, input.planned.selection)) continue;
        return { status: 'complete' };
      }
      if (sent.status === 'sent') {
        if (!sameAdoptionSelection(body.selection, input.planned.selection)) continue;
        return {
          status: 'complete',
          snapshot: { head: sent.receipt.adoption.head, selection: sent.receipt.adoption.selection },
        };
      }
      return { status: 'interrupted', code: sent.code };
    } catch (error) {
      const code = errorCode(error);
      if (permanentReviewRefusal(code)) {
        input.journal.refuseAction(action, code);
        return { status: 'refused', code };
      }
      return { status: 'interrupted', code };
    }
  }
  return { status: 'bound' };
}

export function errorCode(error: unknown): string {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number' && Number.isInteger(status)) return `review-http-${status}`;
  if (error instanceof DOMException && error.name === 'AbortError') return 'review-interrupted';
  return 'review-unavailable';
}

export function permanentReviewRefusal(code: string | null | undefined): boolean {
  return ['review-http-401', 'review-http-403', 'review-http-409', 'review-http-412', 'review-http-423'].includes(
    code ?? '',
  );
}



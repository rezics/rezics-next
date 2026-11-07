import {
  VERIFICATION_ORGANIZATION_TYPE,
  VERIFICATION_PERSON_TYPE,
  VERIFICATION_PLATFORM_CLOSED_MESSAGE,
  VERIFICATION_QUERY_LIMIT,
  VERIFICATION_REQUEST_OPERATION,
  VERIFICATION_WITHDRAW_OPERATION,
  type AgentVerificationRequest,
  type VerificationAttempt,
  type VerificationDraftFields,
  type VerificationEligibleSearchCopy,
  type VerificationFailure,
  type VerificationIssue,
  type VerificationRelease,
  type VerificationSnapshot,
  type VerificationSubject,
  type VerificationSuggestionHit,
  VerificationReadError,
} from '../contract/verification';

export type { VerificationDraftFields, VerificationIssue } from '../contract/verification';

export function verificationCharacterCount(value: string): number {
  return Array.from(value).length;
}

/** Native draft-field bounds, plus the Web's meaningful nonblank text requirements. Never changes input. */
export function validateVerificationDraft(input: VerificationDraftFields): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!input.subject) issues.push({ field: 'subject', code: 'subject-required' });
  if (!input.statement.trim()) issues.push({ field: 'statement', code: 'statement-required' });
  else if (verificationCharacterCount(input.statement) > 2000)
    issues.push({ field: 'statement', code: 'statement-limit' });
  if (input.links.length > 5) {
    issues.push({ field: 'links', code: 'links-limit' });
    return issues;
  }
  input.links.forEach((link, index) => {
    if (!link.label.trim()) issues.push({ field: 'label', index, code: 'label-required' });
    else if (verificationCharacterCount(link.label) > 64) issues.push({ field: 'label', index, code: 'label-limit' });
    if (!link.url) issues.push({ field: 'url', index, code: 'url-required' });
    else if (verificationCharacterCount(link.url) > 2048) issues.push({ field: 'url', index, code: 'url-limit' });
    else {
      // Match access/agent-verification.ts on the original string, before WHATWG URL parsing can repair it.
      let valid = /^https:\/\/[^/@\s]+(?:[/?#]|$)/i.test(link.url) && !/[\u0000-\u0020\u007f]/.test(link.url);
      try {
        const parsed = new URL(link.url);
        valid &&= parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
      } catch {
        valid = false;
      }
      if (!valid) issues.push({ field: 'url', index, code: 'url-https' });
    }
  });
  return issues;
}

export function matchesVerificationInput(request: AgentVerificationRequest, input: VerificationDraftFields): boolean {
  return (
    request.catalogueSubjectId === input.subject &&
    request.statement === input.statement &&
    request.links.length === input.links.length &&
    request.links.every(
      (link, index) => link.label === input.links[index]!.label && link.url === input.links[index]!.url,
    )
  );
}

function admitsVerificationOperation(current: VerificationSnapshot | null, operation: string): boolean {
  return !!current?.viewerActions.some((entry) => entry.operations.includes(operation));
}

export function canRequestVerification(current: VerificationSnapshot | null): boolean {
  return admitsVerificationOperation(current, VERIFICATION_REQUEST_OPERATION);
}

export function canWithdrawVerification(current: VerificationSnapshot | null): boolean {
  return admitsVerificationOperation(current, VERIFICATION_WITHDRAW_OPERATION);
}

/** Original recovery requires the matching current native operation; receipts wait for status readback. */
export function canRetryVerification(
  attempt: VerificationAttempt | null,
  current: VerificationSnapshot | null,
): boolean {
  if (!attempt || attempt.receipt) return false;
  if (attempt.kind === 'request') return canRequestVerification(current);
  return current?.verificationRequest?.id === attempt.requestId && canWithdrawVerification(current);
}

/** Bind withdrawal confirmation to this observation; a newer request, state, or advice is a different command. */
export function verificationWithdrawalObservation(current: VerificationSnapshot | null): string | null {
  const request = current?.verificationRequest;
  if (!current || !request) return null;
  return JSON.stringify({
    id: request.id,
    state: request.state,
    updatedAt: request.updatedAt,
    viewerActions: current.viewerActions,
  });
}

/** Retain the input's UTF-16 budget without cutting a code point in half. */
export function truncateVerificationQuery(value: string, limit = VERIFICATION_QUERY_LIMIT): string {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
}

export function isCurrentVerificationSubject(
  enabled: boolean,
  composing: boolean,
  phase: string,
  subjects: readonly VerificationSubject[],
  subject: VerificationSubject,
): boolean {
  return enabled && !composing && phase === 'ready' && subjects.includes(subject);
}

/** Native Retry-After is a minimum delay, never a schedule for another request. */
export function verificationSearchRetryAt(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return;
  const text = value.trim();
  if (!/^\d+$/.test(text) && !/^[A-Za-z]{3}/.test(text)) return;
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(at) && at <= 8.64e15 ? Math.max(now, at) : undefined;
}

/** Retry-After is either delay-seconds or an HTTP date; an invalid header supplies no delay. */
export function verificationCommandRetryAt(retryAfter: string | undefined, now: number): number {
  if (!retryAfter) return 0;
  const value = retryAfter.trim();
  if (!/^\d+$/.test(value) && !/ GMT$/.test(value)) return 0;
  const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(deadline) && deadline > now ? deadline : 0;
}

export function commandResultIsUncertain(
  recovering: boolean,
  outcome: 'refused' | undefined,
  status: number,
): boolean {
  return (
    recovering ||
    (outcome !== 'refused' && (status === 0 || status === 408 || status >= 500 || status < 400))
  );
}

export function portableVerificationFailure(error: unknown, fallbackMessage?: string): VerificationFailure | undefined {
  if (error instanceof VerificationReadError) return error.failure;
  if (error instanceof Error && error.name === 'TimeoutError')
    return { status: 0, message: fallbackMessage ?? error.message };
  if (error instanceof Error && error.message === VERIFICATION_PLATFORM_CLOSED_MESSAGE) {
    const status = (error as { status?: unknown }).status;
    return {
      status: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 403,
      message: VERIFICATION_PLATFORM_CLOSED_MESSAGE,
    };
  }
  return undefined;
}

export function eligibleVerificationSubjects(
  hits: readonly VerificationSuggestionHit[],
  release: VerificationRelease,
  copy: VerificationEligibleSearchCopy,
): VerificationSubject[] {
  if (!release?.types || typeof release.types !== 'object' || Array.isArray(release.types))
    throw new Error('Invalid eligibility metadata');
  const resolved = new Map<string, Set<string>>();
  const roots = (type: string, visited = new Set<string>()): Set<string> => {
    const known = resolved.get(type);
    if (known) return known;
    const definition = Object.hasOwn(release.types, type) ? release.types[type] : undefined;
    if (
      !definition ||
      typeof definition !== 'object' ||
      Array.isArray(definition) ||
      (definition.bases !== undefined &&
        (!Array.isArray(definition.bases) ||
          definition.bases.some((base: unknown) => typeof base !== 'string' || !base))) ||
      visited.has(type)
    )
      throw new Error('Invalid eligibility metadata');
    if (type === VERIFICATION_PERSON_TYPE || type === VERIFICATION_ORGANIZATION_TYPE) return new Set([type]);
    visited.add(type);
    const result = new Set<string>((definition.bases ?? []).flatMap((base: string) => [...roots(base, visited)]));
    visited.delete(type);
    resolved.set(type, result);
    return result;
  };
  return hits.flatMap((subject) => {
    const title = subject.summary?.label?.value ?? Object.values(subject.labels)[0] ?? subject.id;
    const baseTypes = roots(subject.type);
    if (baseTypes.has(VERIFICATION_PERSON_TYPE)) return [{ id: subject.id, title, type: copy.person }];
    if (baseTypes.has(VERIFICATION_ORGANIZATION_TYPE)) return [{ id: subject.id, title, type: copy.organization }];
    return [];
  });
}

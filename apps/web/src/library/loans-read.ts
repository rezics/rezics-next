import { isCalendarDate } from '@rezics/filter';
import type { KernelClient, Loan, LoanFilter, LoanMutation, LoanPage, LoanWrite } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export type LoanWriteFailure = {
  ok: false;
  reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable';
};
export type LoanSaved = { ok: true; loan: Loan; boundary: LoanMutation['boundary'] };
export type LoanWriteResult = LoanSaved | LoanWriteFailure;
export type LoansPageData = {
  signedIn: boolean;
  filter: LoanFilter;
  requestedCursor: string | null;
  inventoryState?: 'forbidden' | 'unavailable';
  boundary: LoanPage['boundary'] | null;
  items: LoanPage['items'];
  next: string | null;
  csrfToken?: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemBody(error: unknown): unknown {
  return isRecord(error) && 'value' in error ? error.value : undefined;
}

function calendarDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 10) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && year <= 9999 && isCalendarDate({ year, month, day }) ? value : undefined;
}

function counterpartyName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let scalars = 0;
  let visible = false;
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) return undefined;
    if (++scalars > 300) return undefined;
    if (!/\s/u.test(scalar)) visible = true;
  }
  return scalars >= 1 && visible ? value : undefined;
}

function writeHeaders(authorization: string, idempotencyKey: string) {
  return { authorization, 'idempotency-key': JSON.stringify(idempotencyKey) } as {
    authorization: string;
    'idempotency-key': string;
  };
}

export function writeLoanFailure(status: number | undefined, error: unknown): LoanWriteFailure {
  const body = problemBody(error);
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 409) return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'unavailable' };
}

async function bearer(request: Request, sessionEnv: Partial<SessionEnv>): Promise<string | LoanWriteFailure> {
  if (await prepareSession(request, sessionEnv)) return { ok: false, reason: 'forbidden' };
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  return authorization;
}

function parseCreate(input: unknown): (LoanWrite & { idempotencyKey: string }) | undefined {
  if (!isRecord(input)) return undefined;
  const copyId = typeof input.copyId === 'string' && uuid.test(input.copyId) ? input.copyId : undefined;
  const copyRevision =
    typeof input.copyRevision === 'number' && Number.isSafeInteger(input.copyRevision) && input.copyRevision >= 1
      ? input.copyRevision
      : undefined;
  const direction = input.direction === 'lent' || input.direction === 'borrowed' ? input.direction : undefined;
  const startedOn = calendarDay(input.startedOn);
  const dueOn = Object.hasOwn(input, 'dueOn')
    ? input.dueOn === null || input.dueOn === ''
      ? null
      : calendarDay(input.dueOn)
    : undefined;
  const idempotencyKey = typeof input.idempotencyKey === 'string' && uuid.test(input.idempotencyKey) ? input.idempotencyKey : undefined;
  const name = isRecord(input.counterparty) && input.counterparty.kind === 'name' ? counterpartyName(input.counterparty.name) : undefined;
  if (!copyId || copyRevision === undefined || !direction || !startedOn || !idempotencyKey || !name) return undefined;
  if (Object.hasOwn(input, 'dueOn') && dueOn === undefined) return undefined;
  return {
    copyId,
    copyRevision,
    direction,
    counterparty: { kind: 'name', name },
    startedOn,
    ...(dueOn === undefined ? {} : { dueOn }),
    idempotencyKey,
  };
}

function parseRevisioned(
  input: unknown,
): { loanId: string; revision: number; day: string; idempotencyKey: string } | undefined {
  if (!isRecord(input)) return undefined;
  const loanId = typeof input.loanId === 'string' && uuid.test(input.loanId) ? input.loanId : undefined;
  const revision =
    typeof input.revision === 'number' && Number.isSafeInteger(input.revision) && input.revision >= 1
      ? input.revision
      : undefined;
  const day = calendarDay(input.dueOn ?? input.returnedOn);
  const idempotencyKey = typeof input.idempotencyKey === 'string' && uuid.test(input.idempotencyKey) ? input.idempotencyKey : undefined;
  if (!loanId || revision === undefined || !day || !idempotencyKey) return undefined;
  return { loanId, revision, day, idempotencyKey };
}

export async function loadLoansPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { filter: LoanFilter; cursor?: string; limit?: number },
): Promise<LoansPageData> {
  const refused = await prepareSession(request, sessionEnv);
  const authorization = refused ? null : viewerCredential(request);
  const provenance = { filter: input.filter, requestedCursor: input.cursor ?? null };
  if (!authorization)
    return { signedIn: false, ...provenance, boundary: null, items: [], next: null };
  try {
    const limit = input.limit ?? (input.filter === 'history' ? 50 : 20);
    const result = await client['copy-loans'].get({
      query: { filter: input.filter, ...(input.cursor ? { cursor: input.cursor } : {}), limit },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const body = problemBody(result.error);
    if (isPlatformClosedProblem(result.status, body))
      return { signedIn: true, ...provenance, inventoryState: 'unavailable', boundary: null, items: [], next: null };
    if (result.status === 401 || result.status === 403)
      return { signedIn: true, ...provenance, inventoryState: 'forbidden', boundary: null, items: [], next: null };
    if (result.status === 400 || result.status === 409)
      return { signedIn: true, ...provenance, inventoryState: 'unavailable', boundary: null, items: [], next: null };
    if (result.error || !result.data)
      return { signedIn: true, ...provenance, inventoryState: 'unavailable', boundary: null, items: [], next: null };
    return {
      signedIn: true,
      filter: result.data.filter,
      requestedCursor: input.cursor ?? null,
      boundary: result.data.boundary,
      items: result.data.items,
      next: result.data.nextCursor,
    };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError)
      return { signedIn: true, ...provenance, inventoryState: 'unavailable', boundary: null, items: [], next: null };
    throw error;
  }
}

export async function submitLoan(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<LoanWriteResult> {
  const draft = parseCreate(input);
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const { idempotencyKey, ...body } = draft;
    const result = await client['copy-loans'].post(body, { headers: writeHeaders(authorization, idempotencyKey) });
    if (result.error || !result.data?.loan) return writeLoanFailure(result.status, result.error);
    return { ok: true, loan: result.data.loan, boundary: result.data.boundary };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}

export async function extendLoan(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<LoanWriteResult> {
  const draft = parseRevisioned(input);
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const result = await client['copy-loans']({ loanId: draft.loanId }).patch(
      { revision: draft.revision, dueOn: draft.day },
      { headers: writeHeaders(authorization, draft.idempotencyKey) },
    );
    if (result.error || !result.data?.loan) return writeLoanFailure(result.status, result.error);
    return { ok: true, loan: result.data.loan, boundary: result.data.boundary };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}

export async function returnLoan(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<LoanWriteResult> {
  const draft = parseRevisioned({ ...(isRecord(input) ? input : {}), returnedOn: isRecord(input) ? input.returnedOn : undefined });
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const result = await client['copy-loans']({ loanId: draft.loanId }).$return.post(
      { revision: draft.revision, returnedOn: draft.day },
      { headers: writeHeaders(authorization, draft.idempotencyKey) },
    );
    if (result.error || !result.data?.loan) return writeLoanFailure(result.status, result.error);
    return { ok: true, loan: result.data.loan, boundary: result.data.boundary };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}

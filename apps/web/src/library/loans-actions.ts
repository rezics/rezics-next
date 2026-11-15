import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { loansAddress, type LoansAddress } from './loans-query';
import {
  extendLoan,
  loadLoansPage,
  returnLoan,
  submitLoan,
  type LoansPageData,
  type LoanWriteResult,
} from './loans-read';

export type LoansCurrentRead = { sessionSubject: string | null; requested: LoansAddress; page: LoansPageData };

async function loansPageBody(input: unknown): Promise<LoansCurrentRead> {
  const request = getRequest();
  const requested = loansAddress(input, requestLocale(request) ?? 'en');
  if (requested.issue) {
    const refused = await prepareSession(request, env as Partial<SessionEnv>);
    return {
      sessionSubject: refused ? null : (sessionSubject(request) ?? null),
      requested,
      page: {
        signedIn: !!sessionSubject(request),
        filter: requested.filter,
        requestedCursor: requested.cursor,
        boundary: null,
        items: [],
        next: null,
      },
    };
  }
  const page = await loadLoansPage(kernelClient(requested.locale), request, env as Partial<SessionEnv>, {
    filter: requested.filter,
    ...(requested.cursor ? { cursor: requested.cursor } : {}),
  });
  const subject = sessionSubject(request);
  const credential = viewerCredential(request);
  if (!page.signedIn || !subject || !credential)
    return {
      sessionSubject: null,
      requested,
      page: { ...page, signedIn: false, items: [], next: null, csrfToken: null },
    };
  return {
    sessionSubject: subject,
    requested,
    page: { ...page, csrfToken: requestCsrfToken(request) },
  };
}

export const readLoansCurrent = createServerFn({ method: 'GET' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<LoansCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loansPageBody(data);
  });

export const createLoan = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<LoanWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitLoan(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const updateLoanDue = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<LoanWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return extendLoan(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const completeLoan = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<LoanWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return returnLoan(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export type OpenCopyLoanOutcome =
  | { kind: 'found'; item: LoansPageData['items'][number] }
  | { kind: 'continuation'; cursor: string }
  | { kind: 'exhausted' };

export type OpenCopyLoanRead = {
  sessionSubject: string | null;
  copyId: string | null;
  requestedCursor?: string | null;
  page: LoansPageData;
  item: LoansPageData['items'][number] | null;
  outcome?: OpenCopyLoanOutcome | null;
};

export const readOpenCopyLoan = createServerFn({ method: 'GET' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<OpenCopyLoanRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const copyId =
      data && typeof data === 'object' && 'copyId' in data && typeof data.copyId === 'string' ? data.copyId : null;
    const request = getRequest();
    const address = loansAddress(
      {
        filter: 'open',
        ...(data && typeof data === 'object' && 'cursor' in data ? { cursor: data.cursor } : {}),
      },
      requestLocale(request) ?? 'en',
    );
    const requestedCursor = address.issue ? null : address.cursor;
    if (address.issue) {
      const refused = await prepareSession(request, env as Partial<SessionEnv>);
      const subject = sessionSubject(request);
      const credential = viewerCredential(request);
      return {
        sessionSubject: refused || !subject || !credential ? null : subject,
        copyId,
        requestedCursor,
        page: {
          signedIn: !refused && !!subject && !!credential,
          filter: 'open',
          requestedCursor,
          inventoryState: 'unavailable',
          boundary: null,
          items: [],
          next: null,
        },
        item: null,
        outcome: null,
      };
    }
    const page = await loadLoansPage(kernelClient(address.locale), request, env as Partial<SessionEnv>, {
      filter: 'open',
      ...(address.cursor !== null ? { cursor: address.cursor } : {}),
      limit: 100,
    });
    const subject = sessionSubject(request);
    const credential = viewerCredential(request);
    if (!page.signedIn || !subject || !credential)
      return {
        sessionSubject: null,
        copyId,
        requestedCursor,
        page: { ...page, signedIn: false, items: [], next: null },
        item: null,
        outcome: null,
      };
    const item = copyId ? (page.items.find((row) => row.loan.copyId === copyId) ?? null) : null;
    const outcome =
      !page.inventoryState && page.boundary && copyId
        ? item
          ? { kind: 'found' as const, item }
          : page.next !== null
            ? { kind: 'continuation' as const, cursor: page.next }
            : { kind: 'exhausted' as const }
        : null;
    return {
      sessionSubject: subject,
      copyId,
      requestedCursor,
      page: { ...page, csrfToken: requestCsrfToken(request) },
      item,
      outcome,
    };
  });

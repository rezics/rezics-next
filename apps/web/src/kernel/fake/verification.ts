import type { FakeRoute } from '../fake-modules.ts';
import { demoAgentAccounts, demoAgentSubjects } from '../agent-fixtures.ts';
import { isRecord } from './languages.ts';

const verificationPath = /^\/v1\/accounts\/[^/]+\/verification$/;
const verificationSubject = demoAgentSubjects[0]!;
const verificationAccount = demoAgentAccounts.find((account) => account.subject === verificationSubject.id);
let request: Record<string, unknown> | null = null;
let sequence = 0;

export function setFakeVerificationState(state: 'none' | 'pending' | 'approved' | 'rejected'): void {
  request =
    state === 'none'
      ? null
      : {
          id: `fake-verification-${++sequence}`,
          accountId: 'alice',
          accountKind: 'actor',
          requestedBy: 'alice',
          catalogueSubjectId: verificationSubject.id,
          statement: 'This is my catalogue identity.',
          links: [],
          state,
          reason: state === 'rejected' ? 'The evidence did not establish account ownership.' : null,
          problem: null,
          decisionReceiptId: null,
          decidedBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request
    .clone()
    .json()
    .catch(() => ({}));
  return isRecord(value) ? value : {};
}

const read: FakeRoute = {
  method: 'GET',
  path: verificationPath,
  story: () => ({ status: 200, verificationRequest: request }),
  fixture: () => ({ status: 200, verificationRequest: request }),
};

const subject: FakeRoute = {
  method: 'GET',
  path: `/v1/subjects/${verificationSubject.id}`,
  story: () =>
    request?.catalogueSubjectId === verificationSubject.id
      ? {
          status: 200,
          subject: verificationSubject,
          account: verificationAccount ? { id: verificationAccount.id } : null,
          related: {},
        }
      : undefined,
};

async function submitAnswer(incoming: Request) {
  const input = await body(incoming);
  request = {
    id: `fake-verification-${++sequence}`,
    accountId: 'alice',
    accountKind: 'actor',
    requestedBy: 'alice',
    catalogueSubjectId: input.subject,
    statement: input.statement,
    links: input.links,
    state: 'pending',
    reason: null,
    problem: null,
    decisionReceiptId: null,
    decidedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { status: 201, verificationRequest: request };
}

const submit: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/accounts\/[^/]+:requestVerification$/,
  story: ({ request: incoming }) => submitAnswer(incoming),
  fixture: ({ request: incoming }) => submitAnswer(incoming),
};

function withdrawAnswer() {
  if (request) request = { ...request, state: 'withdrawn', updatedAt: new Date().toISOString() };
  return { status: 200, verificationRequest: request };
}

const withdraw: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/accounts\/[^/]+:withdrawVerification$/,
  story: withdrawAnswer,
  fixture: withdrawAnswer,
};

export const routes = [read, subject, submit, withdraw];

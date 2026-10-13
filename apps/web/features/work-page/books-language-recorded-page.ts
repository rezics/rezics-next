import type { MainClient } from '../discover/types.ts';
import { failureOf } from './failure.ts';
import { idOf } from './route.ts';
import type { CreditPage, ReadFailure, WorkHeader, WorkText } from './types.ts';

// The text's recorded language is the language the reader sees. The UI locale
// only chooses the credit presentation; it never replaces the text.

export type RecordedProblem = { type?: string; title: string; code: string; status: number };

export type Answered<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ReadFailure; problem?: RecordedProblem };

export type BooksLanguageCredit = {
  id: string;
  role: string;
  agent: string;
  displayName: string | null;
  handle: string | null;
};

export type BooksLanguageTitle = {
  value: string;
  language: string;
  direction?: 'ltr' | 'rtl';
  basis?: string;
};

export type BooksLanguageReading =
  | {
      kind: 'reading';
      workId: string;
      title: BooksLanguageTitle;
      language: string;
      body: string;
      text: WorkText;
      credit: BooksLanguageCredit | null;
      header: WorkHeader | null;
    }
  | { kind: 'refused'; failure: ReadFailure; problem: RecordedProblem }
  | { kind: 'missing' }
  | { kind: 'unavailable'; failure: ReadFailure };

type CallResult<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  response?: unknown;
};

function recordedProblem(value: unknown, status: number): RecordedProblem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as { type?: unknown; title?: unknown; code?: unknown; status?: unknown };
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return undefined;
  return {
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    title: body.title,
    code: body.code,
    status: typeof body.status === 'number' ? body.status : status,
  };
}

/**
 * The same failure adapter as `settle` in `read.ts`: one retry when Main
 * reports that the graph moved, then `failureOf`. The recorded problem is
 * kept, which `read.ts` does not do until that file can take this client.
 */
async function settleCall<T>(call: () => Promise<CallResult<T>>): Promise<Answered<T>> {
  try {
    let result = await call();
    if (result.error?.status === 409) result = await call();
    if (result.error) {
      const problem = recordedProblem(result.error.value, result.error.status);
      return { ok: false, failure: failureOf(result.error.status), ...(problem ? { problem } : {}) };
    }
    return result.data === null
      ? { ok: false, failure: 'unavailable' }
      : { ok: true, data: result.data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

function recordedAuthor(page: CreditPage): BooksLanguageCredit | null {
  for (const item of page.items) {
    if (item.role === 'author' && item.participantKind === 'agent' && item.agent) {
      return {
        id: item.id,
        role: item.role,
        agent: item.agent,
        displayName: item.displayName,
        handle: item.handle,
      };
    }
  }
  return null;
}

function readingTitle(header: WorkHeader | null | undefined): BooksLanguageTitle | null {
  if (!header?.title.value) return null;
  return {
    value: header.title.value,
    language: header.title.language,
    direction: header.title.direction,
    basis: header.title.basis,
  };
}

function failed(answer: Answered<unknown>): BooksLanguageReading {
  if (answer.ok) return { kind: 'unavailable', failure: 'unavailable' };
  if (answer.problem) return { kind: 'refused', failure: answer.failure, problem: answer.problem };
  if (answer.failure === 'missing') return { kind: 'missing' };
  return { kind: 'unavailable', failure: answer.failure };
}

/**
 * What the reader shows from the Work header, its selected text and its credits.
 * A 200 text is never an empty page. A problem on the text read is the refusal.
 */
export function booksLanguageReading(input: {
  text?: Answered<WorkText> | null;
  credits?: Answered<CreditPage> | null;
  header?: WorkHeader | null;
}): BooksLanguageReading {
  const text = input.text ?? null;
  if (text?.ok && text.data.body.length > 0) {
    const title = readingTitle(input.header);
    if (!title) return { kind: 'unavailable', failure: 'unavailable' };
    return {
      kind: 'reading',
      workId: text.data.work,
      title,
      language: text.data.language,
      body: text.data.body,
      text: text.data,
      credit: input.credits?.ok ? recordedAuthor(input.credits.data) : null,
      header: input.header ?? null,
    };
  }
  if (text && !text.ok) return failed(text);
  return { kind: 'unavailable', failure: 'unavailable' };
}

/**
 * The text page's Main reads, given a client. Production passes the
 * request-cached host from `reader()`; a story passes the replaying client.
 * Queries match `readWorkHeader`, `readText` and the credits GET the page shows.
 */
export function booksLanguageReads(host: { main: MainClient; actingSubject?: string }) {
  const { main, actingSubject } = host;
  return {
    readWorkHeader(id: string): Promise<Answered<WorkHeader>> {
      return settleCall(() => main.v1.works({ id }).get({ query: { actingSubject } }));
    },
    readText(mainVersion: string, language: string | undefined): Promise<Answered<WorkText>> {
      const id = idOf(mainVersion);
      if (!id) return Promise.resolve({ ok: false, failure: 'missing' });
      return settleCall(() =>
        main.v1['main-versions']({ mainVersion: id }).selection.get({ query: { language } }),
      );
    },
    readCredits(work: string, language: string): Promise<Answered<CreditPage>> {
      const id = idOf(work);
      if (!id) return Promise.resolve({ ok: false, failure: 'missing' });
      const query = actingSubject ? { language, actingSubject } : { language };
      return settleCall(() => main.v1.works({ id }).credits.get({ query }));
    },
  };
}

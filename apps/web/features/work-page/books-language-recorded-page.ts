import type { MainClient } from '../discover/types.ts';
import { failureOf } from './failure.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import { idOf } from './route.ts';
import type { AgentCreditPage, CreditPage, Loaded, ReadFailure, WorkHeader, WorkText } from './types.ts';

// The text's recorded language is the language the reader sees. The UI locale
// names that language; it never replaces the text.

export type RecordedProblem = { type?: string; title: string; code: string; status: number };

export type Answered<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ReadFailure; problem?: RecordedProblem };

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
      header: WorkHeader;
      agentCredits: Loaded<AgentCreditPage>;
      credits: Loaded<CreditPage>;
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
 * kept alongside the display category.
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
 * What the reader shows from the Work header and its selected text.
 * A 200 text is never an empty page. A problem on the text read is the refusal.
 */
export function booksLanguageReading(input: {
  text?: Answered<WorkText> | null;
  header?: WorkHeader | null;
  agentCredits?: Loaded<AgentCreditPage>;
  credits?: Loaded<CreditPage>;
}): BooksLanguageReading {
  const text = input.text ?? null;
  if (text?.ok && text.data.body.length > 0) {
    const title = readingTitle(input.header);
    if (!title || !input.header) return { kind: 'unavailable', failure: 'unavailable' };
    return {
      kind: 'reading',
      workId: text.data.work,
      title,
      language: text.data.language,
      body: text.data.body,
      text: text.data,
      header: input.header,
      agentCredits: input.agentCredits ?? { ok: false, failure: 'unavailable' },
      credits: input.credits ?? { ok: false, failure: 'unavailable' },
    };
  }
  if (text && !text.ok) return failed(text);
  return { kind: 'unavailable', failure: 'unavailable' };
}

/**
 * The text page's Main reads, given a client. Production passes the
 * request-cached host from `reader()`; a story passes the replaying client.
 * The shared `booksEditionReads.readWorkHeader` selects the language. The
 * selection query carries only `language`, omitted when the header selects none.
 */
export function booksLanguageReads(host: { main: Pick<MainClient, 'v1'>; actingSubject?: string }) {
  const { main } = host;
  const shared = booksEditionReads(host);
  const readText = (mainVersion: string, language: string | undefined): Promise<Answered<WorkText>> => {
    const id = idOf(mainVersion);
    if (!id) return Promise.resolve({ ok: false, failure: 'missing' });
    return settleCall(() =>
      main.v1['main-versions']({ mainVersion: id }).selection.get({ query: { language } }),
    );
  };
  return {
    readText,
    /** The production reader boundary. A resolved route supplies its cached header/text read. */
    async readPage(id: string, options: {
      header?: WorkHeader;
      language?: string | null;
      readText?: typeof readText;
    } = {}): Promise<BooksLanguagePage> {
      const header = options.header ? { ok: true as const, data: options.header } : await shared.readWorkHeader(id);
      if (!header.ok) return header.failure === 'missing' ? { kind: 'work-missing' }
        : { kind: 'shown', reading: { kind: 'unavailable', failure: header.failure }, actingSubject: host.actingSubject ?? null };
      const text = options.language === null ? { ok: false as const, failure: 'missing' as const }
        : await (options.readText ?? readText)(header.data.mainVersion,
          options.language ?? header.data.selectedLanguage ?? undefined);
      // Refused text never mounts the reader or requests its credits/settings.
      const [agentCredits, credits] = text.ok
        ? await Promise.all([shared.readAgentCredits(id), shared.readCredits(id)]) : [];
      return { kind: 'shown', actingSubject: host.actingSubject ?? null,
        reading: booksLanguageReading({ text, header: header.data, agentCredits, credits }) };
    },
  };
}

export type BooksLanguagePage =
  | { kind: 'work-missing' }
  | { kind: 'shown'; reading: BooksLanguageReading; actingSubject: string | null };

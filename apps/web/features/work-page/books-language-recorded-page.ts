import type { MainClient } from '../discover/types.ts';
import { failureOf } from './failure.ts';
import { idOf } from './route.ts';
import type { CreditPage, ReadFailure, WorkHeader, WorkText } from './types.ts';

// The text's recorded language is the language the reader sees. A presentation
// language chooses the metadata and credit answer; it never replaces the text.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }>
  ? NonNullable<Data>
  : never;
type Works = ReturnType<MainClient['v1']['works']>;
export type WorkMetadata = Ok<Works['metadata']['get']>;

export type RecordedProblem = { title: string; code: string; status: number };

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
  | { kind: 'empty'; workId: string }
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
  const body = value as { title?: unknown; code?: unknown; status?: unknown };
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return undefined;
  return {
    title: body.title,
    code: body.code,
    status: typeof body.status === 'number' ? body.status : status,
  };
}

/** One typed read. A transport failure is thrown so it cannot be shown as a recorded problem. */
async function answeredCall<T>(call: () => Promise<CallResult<T>>): Promise<Answered<T>> {
  const read = async () => {
    const result = await call();
    if (!result.response && result.error) throw result.error.value;
    return result;
  };
  let result = await read();
  if (result.error?.status === 409) result = await read();
  if (result.error) {
    const problem = recordedProblem(result.error.value, result.error.status);
    return { ok: false, failure: failureOf(result.error.status), ...(problem ? { problem } : {}) };
  }
  return result.data === null
    ? { ok: false, failure: 'unavailable' }
    : { ok: true, data: result.data };
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

function readingTitle(
  text: WorkText,
  header: WorkHeader | null | undefined,
  metadata: WorkMetadata | null | undefined,
): BooksLanguageTitle | null {
  if (header?.title.value) {
    return {
      value: header.title.value,
      language: header.title.language,
      direction: header.title.direction,
      basis: header.title.basis,
    };
  }
  const localized = metadata?.localized.find(
    (item) => item.language === text.language && item.title,
  );
  if (localized?.title) return { value: localized.title, language: localized.language };
  if (metadata?.originalTitle)
    return { value: metadata.originalTitle.value, language: metadata.originalTitle.language };
  return null;
}

function failed(answer: Answered<unknown>): BooksLanguageReading {
  if (answer.ok) return { kind: 'unavailable', failure: 'unavailable' };
  if (answer.problem) return { kind: 'refused', failure: answer.failure, problem: answer.problem };
  if (answer.failure === 'missing') return { kind: 'missing' };
  return { kind: 'unavailable', failure: answer.failure };
}

/**
 * What the reader shows from the recorded text, its credits and its metadata.
 * An authorized metadata read with no title is empty. A problem is the refusal
 * Main recorded. A 200 text is never turned into an empty page.
 */
export function booksLanguageReading(input: {
  text?: Answered<WorkText> | null;
  credits?: Answered<CreditPage> | null;
  metadata?: Answered<WorkMetadata> | null;
  header?: WorkHeader | null;
}): BooksLanguageReading {
  const text = input.text ?? null;
  const metadata = input.metadata ?? null;
  if (text?.ok && text.data.body.length > 0) {
    const title = readingTitle(text.data, input.header, metadata?.ok ? metadata.data : null);
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
  if (
    metadata?.ok &&
    metadata.data.originalTitle === null &&
    metadata.data.localized.length === 0
  ) {
    return { kind: 'empty', workId: metadata.data.work };
  }
  if (metadata && !metadata.ok) return failed(metadata);
  return { kind: 'unavailable', failure: 'unavailable' };
}

const presented = (language: string, actingSubject?: string) =>
  actingSubject ? { language, actingSubject } : { language };

/** The published text with the metadata and credits recorded for one presentation language. */
export function fetchPublishedBooksLanguage(
  main: MainClient,
  input: {
    workId: string;
    mainVersionId: string;
    presentationLanguage: string;
    selectionLanguage?: string;
    actingSubject?: string;
  },
): Promise<BooksLanguageReading> {
  const query = presented(input.presentationLanguage, input.actingSubject);
  return Promise.all([
    answeredCall(() =>
      main.v1['main-versions']({ mainVersion: input.mainVersionId }).selection.get({
        query: input.selectionLanguage === undefined ? {} : { language: input.selectionLanguage },
      }),
    ),
    answeredCall(() => main.v1.works({ id: input.workId }).credits.get({ query })),
    answeredCall(() => main.v1.works({ id: input.workId }).metadata.get({ query })),
  ]).then(([text, credits, metadata]) => booksLanguageReading({ text, credits, metadata }));
}

/** The signed-in read: the Work header, then the text in the header's selected language. */
export async function fetchMemberBooksLanguage(
  main: MainClient,
  input: {
    workId: string;
    actingSubject: string;
    presentationLanguage: string;
  },
): Promise<BooksLanguageReading> {
  const header = await answeredCall(() =>
    main.v1.works({ id: input.workId }).get({
      query: { actingSubject: input.actingSubject },
    }),
  );
  if (!header.ok) return failed(header);
  const mainVersionId = idOf(header.data.mainVersion);
  if (!mainVersionId) return { kind: 'unavailable', failure: 'unavailable' };
  const selected = header.data.selectedLanguage ?? undefined;
  const [text, credits] = await Promise.all([
    answeredCall(() =>
      main.v1['main-versions']({ mainVersion: mainVersionId }).selection.get({
        query: selected === undefined ? {} : { language: selected },
      }),
    ),
    answeredCall(() =>
      main.v1.works({ id: input.workId }).credits.get({
        query: { language: input.presentationLanguage, actingSubject: input.actingSubject },
      }),
    ),
  ]);
  return booksLanguageReading({ text, credits, header: header.data });
}

/** One selected text, in a named language or the text Main selects when the language is omitted. */
export async function fetchBooksLanguageSelection(
  main: MainClient,
  mainVersionId: string,
  language?: string,
): Promise<BooksLanguageReading> {
  const text = await answeredCall(() =>
    main.v1['main-versions']({ mainVersion: mainVersionId }).selection.get({
      query: language === undefined ? {} : { language },
    }),
  );
  return booksLanguageReading({ text });
}

/** Metadata alone: an authorized Work with nothing recorded, or a refusal of the Work. */
export async function fetchBooksLanguageMetadata(
  main: MainClient,
  workId: string,
  language: string,
  actingSubject?: string,
): Promise<BooksLanguageReading> {
  const metadata = await answeredCall(() =>
    main.v1.works({ id: workId }).metadata.get({
      query: presented(language, actingSubject),
    }),
  );
  return booksLanguageReading({ metadata });
}

/** Credits for the text page. The Work's text still comes from `readText`. */
export function readBooksLanguageCredits(
  main: MainClient,
  work: string,
  language: string,
  actingSubject?: string,
): Promise<Answered<CreditPage>> {
  const id = idOf(work);
  if (!id) return Promise.resolve({ ok: false, failure: 'missing' });
  return answeredCall(() =>
    main.v1.works({ id }).credits.get({ query: presented(language, actingSubject) }),
  );
}

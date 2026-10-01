import { browserMainApi } from '../api/browser.ts';

// The wizard's contract with Main. Search first: `POST /v1/catalogue/candidates` answers candidates
// and a receipt; `POST /v1/works` takes that receipt with a declared grain and either creates a
// provisional Work or names the owner API to call instead. No rule about grain, quota or
// provisional status lives here: the answers below are Main's, and the wizard shows them.

type Main = ReturnType<typeof browserMainApi>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type CandidateAnswer = Ok<Main['v1']['catalogue']['candidates']['post']>;
export type Candidate = CandidateAnswer['candidates'][number];

/** Every grain Main accepts on `POST /v1/works`, from its request type. */
type CreateBody = Parameters<Main['v1']['works']['post']>[0];
export type Grain = NonNullable<CreateBody['grain']>;

/** What the contributor typed. The language is the one the title is written in. */
export interface SearchInput { text: string; language: string; creator: string }

/** The search a receipt answers: the same input again is the same search. */
export const sameSearch = (a: SearchInput, b: SearchInput) =>
  a.text.trim() === b.text.trim() && a.language === b.language && a.creator.trim() === b.creator.trim();

export type SearchState =
  | { phase: 'idle' }
  | { phase: 'searching'; input: SearchInput }
  | { phase: 'found'; input: SearchInput; receipt: string; candidates: readonly Candidate[] }
  | { phase: 'failed'; input: SearchInput; reason: 'unavailable' | 'signed-out' | 'invalid' };

/**
 * Creating is the last choice: it is offered only after a search for exactly what is typed now has
 * returned. While a search runs, after one fails, or once the text has changed since the last
 * answer, there is no way to create.
 */
export const canCreate = (state: SearchState, current: SearchInput): boolean =>
  state.phase === 'found' && sameSearch(state.input, current);

/** The shortest text worth searching: one CJK character names a title's start; Latin text needs two letters. */
export function searchable(text: string): boolean {
  const phrase = text.trim();
  const wide = /[぀-ヿ㐀-鿿가-힯]/u.test(phrase);
  return [...phrase].length >= (wide ? 1 : 2);
}

const isbn13 = (text: string): string | null => {
  const digits = text.replace(/[\s-]/g, '');
  return /^97[89][0-9]{10}$/.test(digits) ? digits : null;
};

/** A default for the language of what was typed: kana and hangul name their language, anything else keeps the choice. */
export function guessLanguage(text: string, fallback: string): string {
  if (/[぀-ヿ]/u.test(text)) return 'ja';
  if (/[가-힯]/u.test(text)) return 'ko';
  return fallback;
}

/** The request Main's candidate search takes for one input; a valid ISBN-13 is also searched as an identifier. */
export function searchBody(input: SearchInput) {
  const text = input.text.trim();
  const isbn = isbn13(text);
  return { profile: 'catalogue-candidates-v1' as const, originalTitle: { value: text, language: input.language },
    aliases: [], romanizations: [], creators: input.creator.trim() ? [input.creator.trim()] : [], dates: [],
    identifiers: isbn ? [{ isbn13: isbn }] : [] };
}

export interface IntakePort {
  search(input: SearchInput): Promise<SearchState>;
  /** Asks Main where a grain other than a new creative scope goes. */
  ownerApi(grain: Grain, input: SearchInput, receipt: string, actingSubject: string): Promise<OwnerAnswer>;
  create(input: SearchInput, receipt: string, actingSubject: string, semanticType: string | null): Promise<CreateAnswer>;
  /** The unverified state and field provenance of a created Work, or null while Main cannot read it yet. */
  provenance(work: string): Promise<HeaderMark | null>;
}

export type OwnerAnswer =
  | { outcome: 'owner-api'; method: string; path: string }
  | { outcome: 'denied' | 'unavailable' };

export type CreateAnswer =
  | { outcome: 'created'; work: string }
  /** Main is still activating the Work; the same call again returns the same Work. */
  | { outcome: 'pending' }
  /** The contributor has as many records waiting for review as Main allows. */
  | { outcome: 'limit'; retryAfter: number | null }
  /** The search receipt expired or no longer matches: search again. */
  | { outcome: 'search-again' }
  | { outcome: 'denied' | 'unavailable' };

export interface HeaderMark {
  verification: 'unverified' | 'verified' | null;
  provenance: { contributor: string; candidateReceipt: string; fields: readonly string[] } | null;
}

/** One idempotency key per search receipt: sending the same creation again replays it instead of making a second record. */
export const creationKey = (receipt: string) => `catalogue-intake:${receipt}`;

const seconds = (header: string | null): number | null => {
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
};

/** Main as the browser reaches it. The client is made per call: the wizard is also rendered on the server, where there is no window. */
export function mainIntake(given?: Pick<Main, 'v1'>): IntakePort {
  const client = () => given ?? browserMainApi();
  return {
    async search(input) {
      try {
        const answer = await client().v1.catalogue.candidates.post(searchBody(input));
        if (answer.data) return { phase: 'found', input, receipt: answer.data.candidateReceipt, candidates: answer.data.candidates };
        const status = answer.error?.status;
        return { phase: 'failed', input, reason: status === 401 || status === 403 ? 'signed-out' : status === 400 ? 'invalid' : 'unavailable' };
      } catch { return { phase: 'failed', input, reason: 'unavailable' }; }
    },
    async ownerApi(grain, input, receipt, actingSubject) {
      try {
        const answer = await client().v1.works.post({ profile: 'metadata-only-v1', grain, candidateReceipt: receipt,
          title: input.text.trim(), language: input.language, actingSubject },
        { headers: { 'idempotency-key': `${creationKey(receipt)}:${grain}` } });
        if (answer.data && 'outcome' in answer.data) return { outcome: 'owner-api', ...answer.data.ownerApi };
        const status = answer.error?.status;
        return { outcome: status === 401 || status === 403 ? 'denied' : 'unavailable' };
      } catch { return { outcome: 'unavailable' }; }
    },
    async create(input, receipt, actingSubject, semanticType) {
      try {
        const answer = await client().v1.works.post({ profile: 'metadata-only-v1', grain: 'new-creative-scope',
          candidateReceipt: receipt, title: input.text.trim(), language: input.language, actingSubject,
          ...(semanticType ? { semanticTypes: [semanticType] } : {}) } as CreateBody,
        { headers: { 'idempotency-key': creationKey(receipt) } });
        if (answer.data) {
          if ('operationId' in answer.data) return { outcome: 'pending' };
          return 'work' in answer.data ? { outcome: 'created', work: answer.data.work } : { outcome: 'unavailable' };
        }
        const status = answer.error?.status;
        if (status === 429) return { outcome: 'limit', retryAfter: seconds(answer.response.headers.get('retry-after')) };
        if (status === 400 || status === 409) return { outcome: 'search-again' };
        return { outcome: status === 401 || status === 403 ? 'denied' : 'unavailable' };
      } catch { return { outcome: 'unavailable' }; }
    },
    async provenance(work) {
      try {
        const answer = await client().v1.works({ id: work.slice(-36) }).get();
        if (!answer.data) return null;
        return { verification: answer.data.verification ?? null, provenance: answer.data.fieldProvenance ?? null };
      } catch { return null; }
    },
  };
}

/** The first value Main lists for a compared attribute of a candidate. */
export const attributeOf = (candidate: Candidate, field: string) => candidate.attributes.find(item => item.field === field) ?? null;
export const attributesOf = (candidate: Candidate, field: string) => candidate.attributes.filter(item => item.field === field);

/** The Work's ID, as its address uses it. */
export const idOf = (iri: string) => iri.slice(-36);

/**
 * Where an owner API Main names is done in the web app: the realization and release writes are
 * the Editions edit page (G-837), a composition write is the Parts page. Any other path has no page
 * yet; the wizard says so and names the API.
 */
export function destinationOf(ownerPath: string, work: string): string | null {
  const id = encodeURIComponent(idOf(work));
  if (/^\/v1\/works\/\{work\}\/(realizations|releases)\//.test(ownerPath)) return `/w/${id}/edit/editions`;
  return null;
}

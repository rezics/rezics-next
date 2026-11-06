/** Mounted Copy inventory, condition and loan DTOs while whole-Kernel declaration emission is pending.
 * Kernel personal-routes remain the wire authority. These types yield when the generated envelope exists.
 */

export const COPY_CONDITION_VALUES = [
  'unknown',
  'mint',
  'near_mint',
  'very_good_plus',
  'very_good',
  'good',
  'fair',
  'poor',
] as const;

export type CopyConditionValue = (typeof COPY_CONDITION_VALUES)[number];
export type CopyConditionPatch = {
  mediaCondition?: CopyConditionValue | null;
  packagingCondition?: CopyConditionValue | null;
};

export type CopyConditionDisplay =
  | { state: 'not_recorded' }
  | { state: 'unavailable' }
  | { state: 'cleared' }
  | { state: 'recorded'; id: CopyConditionValue; label: string };

export type CopyConditionChoice = { id: CopyConditionValue; label: string; description: string };
export type CopyConditionEditing =
  | { state: 'supported'; currentness: 'current'; choices: readonly CopyConditionChoice[] }
  | {
      state: 'unavailable';
      currentness: 'current' | 'retired' | 'unavailable';
      reason: 'unsupported' | 'unrecognized_vocabulary' | 'retired' | 'current_source_unavailable';
    };

export type CopyConditionPresentation = {
  mediaCondition: CopyConditionDisplay;
  packagingCondition: CopyConditionDisplay;
  conditionEditing: CopyConditionEditing;
};

export type CopyInventoryChoice = {
  id: string;
  label: string;
  labelLanguage?: string;
  meaning: 'available' | 'unsupported' | 'unavailable';
};
export type CopyInventoryFacet = { state: 'available' | 'unavailable'; choices: CopyInventoryChoice[] };
export type CopyInventoryOptions = { kinds: CopyInventoryFacet; statuses: CopyInventoryFacet };

export type LoanDirection = 'lent' | 'borrowed';
export type LoanState = 'overdue' | 'due' | 'undated' | 'returned';
export type LoanFilter = 'open' | 'history';
export type LoanCounterparty =
  | { kind: 'name'; name: string }
  | { kind: 'person'; state: 'available'; personId: string; displayName: string }
  | { kind: 'person'; state: 'concealed' };
export type LoanCounterpartyInput =
  | { kind: 'name'; name: string }
  | { kind: 'person'; personId: string };
export type LoanAction = { allowed: boolean; reason: 'returned' | 'copy_unavailable' | null };
export type LoanDueBoundary = { calendar: 'gregorian'; zone: 'UTC'; today: string };
export type CopyContextFact =
  | { kind: 'item'; id: string; labels: Record<string, string> }
  | { kind: 'time'; year: number; month?: number; day?: number }
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };
export type LoanCopyContext =
  | {
      state: 'available';
      work: { id: string; labels: Record<string, string> }[];
      facts: Record<string, CopyContextFact[]>;
    }
  | { state: 'unsupported'; facts: Record<string, CopyContextFact[]> }
  | { state: 'scope' | 'withheld' | 'missing' | 'unavailable' };
export type LoanCopy = {
  state: 'available' | 'deleted' | 'missing';
  id: string;
  revision: number | null;
  kind: string | null;
  status: string | null;
  context: LoanCopyContext;
};
export type Loan = {
  id: string;
  copyId: string;
  direction: LoanDirection;
  counterparty: LoanCounterparty;
  startedOn: string;
  dueOn: string | null;
  returnedOn: string | null;
  revision: number;
  state: LoanState;
  viewer: { state: 'owner' };
  actions: { extend: LoanAction; return: LoanAction };
};
export type LoanPage = {
  filter: LoanFilter;
  boundary: LoanDueBoundary;
  generation: number;
  items: { loan: Loan; copy: LoanCopy }[];
  nextCursor: string | null;
};
export type LoanWrite = {
  copyId: string;
  copyRevision: number;
  direction: LoanDirection;
  counterparty: LoanCounterpartyInput;
  startedOn: string;
  dueOn?: string | null;
};
export type LoanExtend = { revision: number; dueOn: string };
export type LoanReturn = { revision: number; returnedOn: string };
export type LoanMutation = { loan: Loan; boundary: LoanDueBoundary };

type Call<T> = Promise<{
  data: T | null;
  error: { value: unknown; status?: number } | null;
  response: Response;
  status: number;
  headers: Headers;
}>;
type ReadOptions = { headers?: Record<string, string>; fetch?: { cache?: RequestCache; redirect?: RequestRedirect } };
type WriteOptions = { headers: Record<string, string> & { 'idempotency-key': string } };

export type CopyLoansClient = ((params: { loanId: string }) => {
  patch(body: LoanExtend, options: WriteOptions): Call<LoanMutation>;
  return: { post(body: LoanReturn, options: WriteOptions): Call<LoanMutation> };
}) & {
  get(
    options?: ReadOptions & { query?: { filter?: LoanFilter; cursor?: string; limit?: number } },
  ): Call<LoanPage>;
  post(body: LoanWrite, options: WriteOptions): Call<LoanMutation>;
};

type GeneratedListData<Client> = Client extends { copies: { get: (...args: never[]) => Promise<{ data: infer Data }> } }
  ? NonNullable<Data>
  : never;
type GeneratedCreateBody<Client> = Client extends {
  copies: { post: (body: infer Body, ...args: never[]) => unknown };
}
  ? Body
  : never;
type GeneratedCopy<Client> = Client extends {
  copies: (params: { copyId: string }) => { get: (...args: never[]) => Promise<{ data: infer Data }> };
}
  ? NonNullable<Data> extends { copy: infer Copy }
    ? Copy
    : never
  : never;
type GeneratedPatchBody<Client> = Client extends {
  copies: (params: { copyId: string }) => { patch: (body: infer Body, ...args: never[]) => unknown };
}
  ? Body
  : never;

export type CopyListHasFilters<Client> = GeneratedListData<Client> extends { filterOptions: unknown } ? true : false;
export type CopyConditionBodyPublished<Client> = GeneratedCreateBody<Client> extends { mediaCondition?: unknown }
  ? true
  : false;
export type CopyConditionPresentationPublished<Client> =
  NonNullable<GeneratedCopy<Client> extends { presentation?: infer Presentation } ? Presentation : never> extends {
    mediaCondition: unknown;
  }
    ? true
    : false;
export type CopyLoansPublished<Client> = 'copy-loans' extends keyof Client ? true : false;

export type CopyListQueryOverlay<Query> = Query & { kind?: string; status?: string };
export type CopyListDataOverlay<Data> = Data & { filterOptions: CopyInventoryOptions };
export type CopyWriteBodyOverlay<Body> = Body & CopyConditionPatch;
export type CopyPresentationOverlay<Copy> = Copy extends { presentation?: infer Presentation }
  ? Omit<Copy, 'presentation'> & {
      presentation?: (Presentation extends object ? Presentation : {}) & Partial<CopyConditionPresentation>;
    }
  : Copy;

export type { GeneratedListData, GeneratedCreateBody, GeneratedCopy, GeneratedPatchBody };

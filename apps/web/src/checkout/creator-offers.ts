import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import {
  createNativeEditionApi,
  parseEditionMetadata,
  type EditionApi,
  type EditionMetadata,
} from '../content-editions/edition-api';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readSessionIdentity } from '../session/state';
import {
  createNativeMoneySchemaApi,
  parseMoneySchema,
  recordedMoneyUnit,
  recordedTaxBehavior,
  type CommerceMoneySchema,
  type MoneySchemaApi,
} from './money-schema';
import { UUID } from './price';
import { creatorEditionSearch, creatorOffersSearch, type CreatorOffersSearch } from './creator-offer-address';
export { creatorEditionSearch, creatorOffersSearch } from './creator-offer-address';
export type { CreatorOffersSearch } from './creator-offer-address';

type NativeCreatorOffer = NonNullable<Awaited<ReturnType<KernelClient['offers']['get']>>['data']>['offers'][number];
/** Current native seller DTO, also accepting absence of nullable metadata in historical recordings. */
export type CreatorOffer = Omit<NativeCreatorOffer, 'moneyUnit' | 'taxBehavior'> &
  Partial<Pick<NativeCreatorOffer, 'moneyUnit' | 'taxBehavior'>>;
export const CREATOR_OFFERS_PAGE_SIZE = 20;
export type CreatorOffersData =
  | { kind: 'ready'; offers: CreatorOffer[]; next: string | null }
  | { kind: 'denied' | 'unavailable' | 'error' | 'stale' | 'preparing' | 'closed' | 'rejected' };
/** One native owned-list caller; no public catalogue or receipt-derived substitute. */
export type CreatorOffersCaller = {
  get(input: {
    query: { limit: number; cursor?: string };
    headers: { authorization: string };
  }): Promise<{ status: number; data: { offers: CreatorOffer[]; next: string | null } | null }>;
};
export function createNativeCreatorOffersCaller(client?: Pick<KernelClient, 'offers'>): CreatorOffersCaller {
  return {
    async get(input) {
      if (!client) return { status: 503, data: null };
      const result = await client.offers.get({ ...input, fetch: { cache: 'no-store', redirect: 'manual' } });
      return { status: result.status, data: result.error ? null : result.data };
    },
  };
}
export const unavailableCreatorOffersCaller = createNativeCreatorOffersCaller();

export type CreatorFailure = { kind: 'denied' | 'closed' | 'unavailable' | 'rejected' };
export type OwnedOffersData = CreatorOffersData;
export interface OwnedOffersApi {
  /** Compatibility port for the single native listing; no alternate catalogue. */
  list(authorization: string, input: { limit: 20; cursor?: string }): Promise<OwnedOffersData>;
}
export const nativeOwnedOffersApi: OwnedOffersApi = {
  async list() {
    return { kind: 'unavailable' };
  },
};
export type CreatorEditorData =
  | {
      kind: 'ready';
      edition: EditionMetadata;
      schema: CommerceMoneySchema;
    }
  | CreatorFailure
  | { kind: 'choose-edition' };
export type CreatorEditorPageData = {
  editor: CreatorEditorData;
  csrfToken: string;
  createKey: string;
  selling: boolean;
};
export type CreatorOffersPageData = {
  page: OwnedOffersData;
  schema: CommerceMoneySchema | null;
  csrfToken: string;
  selling: boolean;
  keys: Record<string, { reprice: string; delist: string }>;
};
export type CreatorOffersAddress = { kind: 'list'; cursor: string | null };
export type CreatorEditorAddress = { kind: 'editor'; contentEditionId: string | null };
export type CreatorOfferAddress = CreatorOffersAddress | CreatorEditorAddress;
export type CreatorCurrentRead<T, A extends CreatorOfferAddress> = {
  sessionSubject: string | null;
  requested: A;
  data: T;
};
export type CreatorOffersCurrentRead = CreatorCurrentRead<CreatorOffersPageData, CreatorOffersAddress>;
export type CreatorEditorCurrentRead = CreatorCurrentRead<CreatorEditorPageData, CreatorEditorAddress>;
/** A mounted origin supplies current CSRF only while its viewer/address/admission still holds. */
export type CreatorOfferGuard = { isCurrent(): boolean; csrfToken(): string | null };
export type CreatorOfferMutation =
  | {
      operation: 'create';
      idempotencyKey: string;
      contentEditionId: string;
      title: string;
      currency: 'usd' | 'eur';
      unitAmountMinor: number;
      taxCode: string;
    }
  | { operation: 'reprice'; idempotencyKey: string; offerId: string; expectedRevision: number; unitAmountMinor: number }
  | { operation: 'delist'; idempotencyKey: string; offerId: string; expectedRevision: number };
export type CreatorOfferResult = { kind: 'saved'; id: string } | CreatorFailure | { kind: 'retry' | 'conflict' };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid creator offer input');
  return value as Record<string, unknown>;
}
function input(value: unknown): CreatorOffersSearch {
  const search = creatorOffersSearch(object(value));
  if (search.addressIssue) throw new Error('Invalid creator offer address');
  return search;
}
function editionInput(value: unknown) {
  const search = creatorEditionSearch(object(value));
  if (search.addressIssue) throw new Error('Invalid creator edition address');
  return search;
}
function validOffer(row: CreatorOffer): boolean {
  return (
    !!row &&
    UUID.test(row.id) &&
    UUID.test(row.targetSubjectId) &&
    typeof row.title === 'string' &&
    row.title.length > 0 &&
    typeof row.currency === 'string' &&
    /^[a-z]{3}$/i.test(row.currency) &&
    Number.isSafeInteger(row.unitAmountMinor) &&
    row.unitAmountMinor > 0 &&
    typeof row.taxCode === 'string' &&
    Number.isInteger(row.royaltyBasisPoints) &&
    row.royaltyBasisPoints >= 0 &&
    row.royaltyBasisPoints <= 10000 &&
    Number.isSafeInteger(row.revision) &&
    row.revision >= 1 &&
    (row.state === 'active' || row.state === 'delisted') &&
    (row.contentEdition === null ||
      (!!row.contentEdition &&
        row.contentEdition.benefit?.kind === 'content-edition' &&
        row.contentEdition.benefit.resourceType === 'content.edition' &&
        row.contentEdition.benefit.action === 'edition:read' &&
        UUID.test(row.contentEdition.benefit.resource?.id) &&
        UUID.test(row.contentEdition.benefit.version?.revisionId) &&
        /^[a-f0-9]{64}$/.test(row.contentEdition.benefit.version.sha256) &&
        row.contentEdition.targetSubjectId === row.targetSubjectId &&
        typeof row.contentEdition.source?.licence === 'string' &&
        row.contentEdition.delivery === 'fixed-content-edition' &&
        row.contentEdition.acquisition === 'one-time-account-bound' &&
        row.contentEdition.quantity === 1))
  );
}
/** One bounded private page using this request's current credential, with no owner selector or fanout. */
export async function loadCreatorOffers(
  caller: CreatorOffersCaller,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  search: CreatorOffersSearch,
): Promise<CreatorOffersData> {
  try {
    const query = input(search);
    if (await prepareSession(request, sessionEnv)) return { kind: 'denied' };
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    return await loadPreparedCreatorOffers(caller, authorization, query);
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Share the composed viewer's preparation instead of refreshing or capturing a second credential. */
async function loadPreparedCreatorOffers(
  caller: CreatorOffersCaller,
  authorization: string,
  query: CreatorOffersSearch,
  subject?: string,
): Promise<CreatorOffersData> {
  try {
    const result = await caller.get({
      query: { limit: CREATOR_OFFERS_PAGE_SIZE, ...query },
      headers: { authorization },
    });
    if ([401, 403, 404].includes(result.status)) return { kind: 'denied' };
    if (result.status === 409) return { kind: 'stale' };
    if (result.status === 400) return { kind: 'error' };
    const page = result.data;
    if (
      result.status !== 200 ||
      !page ||
      !Array.isArray(page.offers) ||
      page.offers.length > CREATOR_OFFERS_PAGE_SIZE ||
      !page.offers.every(validOffer) ||
      (subject !== undefined &&
        page.offers.some(
          (offer) => offer.contentEdition !== null && offer.contentEdition.creatorAccountId !== subject,
        )) ||
      !(page.next === null || (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096))
    )
      return { kind: 'unavailable' };
    // Construct the seller shape explicitly so an injected/malformed response cannot forward metadata.
    const offers = page.offers.map(
      ({
        id,
        targetSubjectId,
        title,
        currency,
        unitAmountMinor,
        taxCode,
        royaltyBasisPoints,
        state,
        revision,
        contentEdition,
        moneyUnit,
        taxBehavior,
      }) => ({
        id,
        targetSubjectId,
        title,
        currency,
        unitAmountMinor,
        taxCode,
        royaltyBasisPoints,
        state,
        revision,
        ...(moneyUnit === undefined ? {} : { moneyUnit: recordedMoneyUnit({ moneyUnit }) }),
        ...(taxBehavior === undefined ? {} : { taxBehavior: recordedTaxBehavior({ taxBehavior }) }),
        contentEdition:
          contentEdition === null
            ? null
            : {
                benefit: {
                  kind: contentEdition.benefit.kind,
                  resourceType: contentEdition.benefit.resourceType,
                  resource: { route: contentEdition.benefit.resource.route, id: contentEdition.benefit.resource.id },
                  version: {
                    revisionId: contentEdition.benefit.version.revisionId,
                    sha256: contentEdition.benefit.version.sha256,
                  },
                  action: contentEdition.benefit.action,
                },
                creatorAccountId: contentEdition.creatorAccountId,
                targetSubjectId: contentEdition.targetSubjectId,
                source: { licence: contentEdition.source.licence },
                saleTermsReference: contentEdition.saleTermsReference,
                delivery: contentEdition.delivery,
                acquisition: contentEdition.acquisition,
                quantity: contentEdition.quantity,
              },
      }),
    );
    return { kind: 'ready', offers, next: page.next };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function validateCreatorOfferMutation(value: unknown): CreatorOfferMutation {
  const input = object(value);
  const { operation, idempotencyKey } = input;
  if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) throw new Error('Invalid offer key');
  const raw = input.unitAmountMinor;
  const validAmount = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 50 && raw <= 99999999;
  if (operation === 'create') {
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'operation',
            'idempotencyKey',
            'contentEditionId',
            'title',
            'currency',
            'unitAmountMinor',
            'taxCode',
          ].includes(key),
      ) ||
      typeof input.contentEditionId !== 'string' ||
      !UUID.test(input.contentEditionId) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 1024 ||
      (input.currency !== 'usd' && input.currency !== 'eur') ||
      !validAmount ||
      typeof input.taxCode !== 'string' ||
      !input.taxCode.trim() ||
      input.taxCode.length > 256
    )
      throw new Error('Invalid offer terms');
    return {
      operation,
      idempotencyKey,
      contentEditionId: input.contentEditionId,
      title: input.title,
      currency: input.currency,
      unitAmountMinor: raw,
      taxCode: input.taxCode,
    };
  }
  if (
    (operation !== 'reprice' && operation !== 'delist') ||
    typeof input.offerId !== 'string' ||
    !UUID.test(input.offerId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 1 ||
    Object.keys(input).some(
      (key) =>
        ![
          'operation',
          'idempotencyKey',
          'offerId',
          'expectedRevision',
          ...(operation === 'reprice' ? ['unitAmountMinor'] : []),
        ].includes(key),
    ) ||
    (operation === 'reprice' && !validAmount)
  )
    throw new Error('Invalid offer change');
  return operation === 'delist'
    ? { operation, idempotencyKey, offerId: input.offerId, expectedRevision: input.expectedRevision as number }
    : {
        operation,
        idempotencyKey,
        offerId: input.offerId,
        expectedRevision: input.expectedRevision as number,
        unitAmountMinor: raw as number,
      };
}

/** Only exact Content metadata; ID shape, author labels and public posts cannot establish sale rights. */
export async function loadCreatorEditor(
  editionApi: EditionApi,
  moneyApi: MoneySchemaApi,
  authorization: string,
  contentEditionId?: string,
  subject?: string,
): Promise<CreatorEditorData> {
  if (!contentEditionId) return { kind: 'choose-edition' };
  try {
    const metadata = await editionApi.readMetadata(contentEditionId, authorization);
    if (metadata.state === 'refused') return { kind: 'denied' };
    if (metadata.state !== 'available') return { kind: 'unavailable' };
    const edition = parseEditionMetadata(metadata.value);
    if (!edition || edition.editionId !== contentEditionId) return { kind: 'unavailable' };
    if (subject !== undefined && edition.creatorAccountId !== subject) return { kind: 'denied' };
    if (edition.state !== 'published') return { kind: 'rejected' };
    const money = await moneyApi.read(authorization);
    if (money.kind !== 'ready') return { kind: 'unavailable' };
    const schema = parseMoneySchema(money.schema);
    return schema ? { kind: 'ready', edition, schema } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Existing native writes own current rights, consent, revision, receipts and immutable captured benefit terms. */
export async function submitCreatorOffer(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  value: CreatorOfferMutation,
): Promise<CreatorOfferResult> {
  let input: CreatorOfferMutation;
  try {
    input = validateCreatorOfferMutation(value);
  } catch {
    return { kind: 'rejected' };
  }
  try {
    const stale = await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'denied' };
    const headers = { authorization, 'idempotency-key': input.idempotencyKey };
    // Keep the complete wire body while controller generation updates the client declaration.
    const repriceBody =
      input.operation === 'reprice'
        ? { unitAmountMinor: input.unitAmountMinor, expectedRevision: input.expectedRevision }
        : undefined;
    const result =
      input.operation === 'create'
        ? await client.offers.post(
            {
              contentEditionId: input.contentEditionId,
              title: input.title,
              currency: input.currency,
              unitAmountMinor: input.unitAmountMinor,
              taxCode: input.taxCode,
            },
            { headers },
          )
        : input.operation === 'reprice'
          ? await client.offers({ offerId: input.offerId }).patch(repriceBody!, { headers })
          : await client
              .offers({ offerId: input.offerId })
              .$delist.post({ expectedRevision: input.expectedRevision }, { headers });
    if (result.error) {
      if (isPlatformClosedProblem(result.status, result.error.value)) return { kind: 'closed' };
      if ([401, 403, 404].includes(result.status)) return { kind: 'denied' };
      if (input.operation !== 'create' && result.status === 409) return { kind: 'conflict' };
      if ([400, 409, 422].includes(result.status)) return { kind: 'rejected' };
      return { kind: 'retry' };
    }
    const id = result.data?.offer.id;
    if (!id || !UUID.test(id) || (input.operation !== 'create' && id !== input.offerId)) return { kind: 'retry' };
    return { kind: 'saved', id };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'closed' : 'retry' };
  }
}

function privatePage() {
  setResponseHeader('cache-control', 'private, no-store');
  setResponseHeader('x-robots-tag', 'noindex, nofollow');
}
async function viewer(requireSubject = false) {
  // A current read cannot inherit an earlier Request's retained preparation operands.
  const request = requireSubject ? new Request(getRequest()) : getRequest();
  const denied = { authorization: null, sessionSubject: null, csrfToken: '', selling: false };
  if (await prepareSession(request, env as Partial<SessionEnv>)) return denied;
  const authorization = viewerCredential(request);
  const subject = request.headers.has('authorization') ? null : (sessionSubject(request) ?? null);
  if (!authorization || (requireSubject && !subject)) return denied;
  const identity = await readSessionIdentity(request, env as Partial<SessionEnv>);
  const result = await kernelClient().platform.exposure.get({
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (result && (result.error || !result.data)) throw new Error('Platform exposure unavailable');
  return {
    authorization,
    sessionSubject: subject,
    csrfToken: identity.csrfToken ?? '',
    selling: !!result?.data?.admitted.includes('selling'),
  };
}

async function editorPage(
  current: Awaited<ReturnType<typeof viewer>>,
  contentEditionId?: string,
  strict = false,
): Promise<CreatorEditorPageData> {
  const empty = { csrfToken: '', createKey: crypto.randomUUID(), selling: false };
  if (!current.authorization) return { ...empty, editor: { kind: 'denied' } };
  const editor = !current.selling
    ? { kind: 'closed' as const }
    : await loadCreatorEditor(
        createNativeEditionApi(kernelClient()),
        createNativeMoneySchemaApi(kernelClient()),
        current.authorization,
        contentEditionId,
        strict ? current.sessionSubject! : undefined,
      );
  return { ...empty, csrfToken: current.csrfToken, selling: current.selling, editor };
}

async function offersPage(
  current: Awaited<ReturnType<typeof viewer>>,
  search: CreatorOffersSearch,
  strict = false,
): Promise<CreatorOffersPageData> {
  const empty = { schema: null, csrfToken: '', selling: false, keys: {} };
  if (!current.authorization) return { ...empty, page: { kind: 'denied' } };
  if (!current.selling) return { ...empty, page: { kind: 'closed' } };
  const page = await loadPreparedCreatorOffers(
    createNativeCreatorOffersCaller(kernelClient()),
    current.authorization,
    search,
    strict ? current.sessionSubject! : undefined,
  );
  const money = await createNativeMoneySchemaApi(kernelClient()).read(current.authorization);
  const schema = money.kind === 'ready' ? parseMoneySchema(money.schema) : null;
  return {
    csrfToken: current.csrfToken,
    selling: current.selling,
    schema,
    page,
    keys:
      page.kind === 'ready'
        ? Object.fromEntries(
            page.offers.map((offer) => [offer.id, { reprice: crypto.randomUUID(), delist: crypto.randomUUID() }]),
          )
        : {},
  };
}

export const readCreatorOfferEditor = createServerFn({ method: 'GET' })
  .validator(editionInput)
  .handler(async ({ data }): Promise<CreatorEditorPageData> => {
    privatePage();
    const empty = { csrfToken: '', createKey: crypto.randomUUID(), selling: false };
    try {
      return await editorPage(await viewer(), data.contentEditionId);
    } catch {
      return { ...empty, editor: { kind: 'unavailable' } };
    }
  });

export const readCreatorOffers = createServerFn({ method: 'GET' })
  .validator(input)
  .handler(async ({ data }): Promise<CreatorOffersPageData> => {
    privatePage();
    const empty = { schema: null, csrfToken: '', selling: false, keys: {} };
    try {
      return await offersPage(await viewer(), data);
    } catch {
      return { ...empty, page: { kind: 'unavailable' } };
    }
  });

/** Additive route readers bind even an empty page to one actual preparation and normalized address. */
export const readCreatorOffersCurrent = createServerFn({ method: 'GET' })
  .validator(input)
  .handler(async ({ data }): Promise<CreatorOffersCurrentRead> => {
    privatePage();
    const requested: CreatorOffersAddress = { kind: 'list', cursor: data.cursor ?? null };
    let subject: string | null = null;
    try {
      const current = await viewer(true);
      subject = current.sessionSubject;
      return { sessionSubject: subject, requested, data: await offersPage(current, data, true) };
    } catch {
      return {
        sessionSubject: subject,
        requested,
        data: { page: { kind: 'unavailable' }, schema: null, csrfToken: '', selling: false, keys: {} },
      };
    }
  });

export const readCreatorOfferEditorCurrent = createServerFn({ method: 'GET' })
  .validator(editionInput)
  .handler(async ({ data }): Promise<CreatorEditorCurrentRead> => {
    privatePage();
    const requested: CreatorEditorAddress = { kind: 'editor', contentEditionId: data.contentEditionId ?? null };
    let subject: string | null = null;
    try {
      const current = await viewer(true);
      subject = current.sessionSubject;
      return { sessionSubject: subject, requested, data: await editorPage(current, data.contentEditionId, true) };
    } catch {
      return {
        sessionSubject: subject,
        requested,
        data: { editor: { kind: 'unavailable' }, csrfToken: '', createKey: crypto.randomUUID(), selling: false },
      };
    }
  });

export const manageCreatorOffer = createServerFn({ method: 'POST' })
  .validator(validateCreatorOfferMutation)
  .handler(({ data }) => {
    privatePage();
    return submitCreatorOffer(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

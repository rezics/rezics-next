import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { creatorSaleEditionReader } from '../content-editions/sale-review';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readSessionIdentity } from '../session/state';
import {
  creatorOffersInput,
  creatorEditionInput,
  loadPreparedCreatorOffers,
  loadCreatorEditor,
  createNativeCreatorOffersCaller,
  type CreatorEditorPageData,
  type CreatorOffersPageData,
  type CreatorOffersAddress,
  type CreatorEditorAddress,
  type CreatorOffersCurrentRead,
  type CreatorEditorCurrentRead,
  type CreatorOffersSearch,
} from '../checkout/creator-offers';
import { createNativeMoneySchemaApi, parseMoneySchema } from '../checkout/money-schema';

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
        creatorSaleEditionReader(kernelClient()),
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
  .validator(creatorEditionInput)
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
  .validator(creatorOffersInput)
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
  .validator(creatorOffersInput)
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
  .validator(creatorEditionInput)
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

/** Ordinary routes install these readers; no global setter or startup registration. */
export const creatorOfferReaders = {
  list: (input: Parameters<typeof readCreatorOffersCurrent>[0]) => readCreatorOffersCurrent(input),
  editor: (input: Parameters<typeof readCreatorOfferEditorCurrent>[0]) => readCreatorOfferEditorCurrent(input),
};

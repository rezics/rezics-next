import { readPublicationPreparation } from './realm-publication-preparation';
import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateRealmClaimStatusRead, type RealmClaimStatusInput } from './realm-claim-status';
import { readRealmClaimStatus, type RealmClaimStatusEnv } from './realm-claim-status-native';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import * as v from 'valibot';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import {
  preparedReviewReader,
  sameReviewReader,
  validateReviewReaderExpectation,
  type ReviewReaderExpectation,
  type ReviewReaderProvenance,
} from '../subject/write-review-lifetime';
import {
  commandSetup,
  readSetup,
  readSetupChoice,
  setupCommandSchema,
  setupReadSchema,
  setupChoiceSchema,
  type SetupFailure,
  type SetupReaderProvenance,
} from './space-setup';
import {
  requestRealmMembership,
  requestRealmMemberAddition,
  loadMyRealms,
  loadSpacePageWithOrigin,
  locateRealmWithOrigin,
  namePublishedTypes,
  loadRealmShelfPageWithOrigin,
  type Located,
  type MembershipResult,
  type RealmMemberAdditionInput,
  type MyRealmsPage,
  type ReaderOrigin,
  type ShelfPage,
  type RealmBoard,
  type PublishedSubject,
  type SpacePageData,
} from './space';
import { changePublication, type PublicationChange, type PublicationOutcome } from './publication-controls';
import { loadRealmBans, loadRealmBanTarget, validateBanRead, validateBanWrite, writeRealmBan } from './realm-bans';
import {
  realmAppearanceReadSchema,
  realmAppearanceCommandSchema,
  realmAppearanceChoiceSchema,
} from './realm-presentation';
import { readRealmAppearance, changeRealmAppearance, selectRealmAppearance } from './realm-presentation-native';
import {
  nativeContainerLifecycleAdapter,
  lifecycleReadSchema,
  lifecycleCommandSchema,
  lifecycleDestinationSchema,
} from './container-lifecycle-native';
import { readRealmClaim, writeRealmClaim } from './realm-claim-native';
import { validateRealmClaimInput, type RealmClaimInput } from './realm-claim';
import { readSetupContextDirectory, setupContextDirectorySchema } from './setup-context-native';
import { boardChoiceReadSchema, readNativeBoardChoices } from './setup-board-native';
import { requestLanguages } from '../kernel/languages';

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function credentialModeOf(input: Record<string, unknown>): ReadCredentialMode {
  if (input.credentialMode === undefined || input.credentialMode === 'anonymous') return 'anonymous';
  if (input.credentialMode === 'session') return 'session';
  throw new Error('Invalid read credential mode');
}

function validateAddress(input: unknown): { address: string; credentialMode: ReadCredentialMode } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('address' in input) ||
    typeof input.address !== 'string' ||
    input.address.length === 0 ||
    input.address.length > 128
  )
    throw notFound();
  return { address: input.address, credentialMode: credentialModeOf(input) };
}

function validateRealm(input: unknown): { realmId: string; credentialMode: ReadCredentialMode } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('realmId' in input) ||
    typeof input.realmId !== 'string' ||
    input.realmId.length === 0 ||
    input.realmId.length > 128
  )
    throw notFound();
  return { realmId: input.realmId, credentialMode: credentialModeOf(input) };
}

function validateCursor(input: unknown): { cursor?: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    ('cursor' in input &&
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || input.cursor.length > 4096))
  )
    throw new Error('Invalid Realms cursor');
  return 'cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {};
}

function validateReviewMyRealmsRead(input: unknown): { expected: ReviewReaderExpectation } {
  if (!input || typeof input !== 'object' || !('expected' in input)) throw new Error('Invalid review reader');
  return { expected: validateReviewReaderExpectation(input.expected) };
}

function validateChange(input: unknown): { realmId: string; action: 'join' | 'leave'; idempotencyKey: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('realmId' in input) ||
    typeof input.realmId !== 'string' ||
    input.realmId.length === 0 ||
    input.realmId.length > 128 ||
    !('action' in input) ||
    (input.action !== 'join' && input.action !== 'leave') ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !idempotencyKeyPattern.test(input.idempotencyKey)
  )
    throw new Error('Invalid Realm membership request');
  return { realmId: input.realmId, action: input.action, idempotencyKey: input.idempotencyKey };
}

function validateMemberAddition(input: unknown): RealmMemberAdditionInput {
  if (
    !input ||
    typeof input !== 'object' ||
    !('realmId' in input) ||
    typeof input.realmId !== 'string' ||
    !idempotencyKeyPattern.test(input.realmId) ||
    !('accountId' in input) ||
    typeof input.accountId !== 'string' ||
    !idempotencyKeyPattern.test(input.accountId) ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !idempotencyKeyPattern.test(input.idempotencyKey)
  )
    throw new Error('Invalid Realm member addition');
  return { realmId: input.realmId, accountId: input.accountId, idempotencyKey: input.idempotencyKey };
}

export const readSpacePage = createServerFn({ method: 'GET' })
  .validator(validateAddress)
  .handler(async ({ data }): Promise<SpacePageData & { readerOrigin: ReaderOrigin }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const result = await loadSpacePageWithOrigin(
      kernelClient(),
      request,
      env as Partial<SessionEnv>,
      { ...data, languages: requestLanguages(requestLocale(request) ?? 'en') },
      data.credentialMode,
    );
    return {
      ...(await namePublishedTypes(result.value, requestLocale(request) ?? 'en')),
      readerOrigin: result.readerOrigin,
    };
  });

export const locateRealmPage = createServerFn({ method: 'GET' })
  .validator(validateRealm)
  .handler(async ({ data }): Promise<Located & { readerOrigin: ReaderOrigin }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const result = await locateRealmWithOrigin(
      kernelClient(),
      request,
      env as Partial<SessionEnv>,
      { ...data, languages: requestLanguages(requestLocale(request) ?? 'en') },
      data.credentialMode,
    );
    const located = result.value;
    return located.kind === 'page'
      ? {
          ...located,
          page: await namePublishedTypes(located.page, requestLocale(request) ?? 'en'),
          readerOrigin: result.readerOrigin,
        }
      : { ...located, readerOrigin: result.readerOrigin };
  });

export const readMyRealmsPage = createServerFn({ method: 'GET' })
  .validator(validateCursor)
  .handler(async ({ data }): Promise<MyRealmsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMyRealms(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export type ReviewMyRealmsRead =
  | { kind: 'ready'; page: MyRealmsPage; provenance: ReviewReaderProvenance }
  | { kind: 'mismatch' };

/** Adds same-request reader provenance while retaining the original bounded My Realms read. */
export const readMyRealmsPageForReview = createServerFn({ method: 'GET' })
  .validator(validateReviewMyRealmsRead)
  .handler(async ({ data }): Promise<ReviewMyRealmsRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadMyRealms(kernelClient(), request, env as Partial<SessionEnv>, {});
    const provenance = await preparedReviewReader(sessionSubject(request), requestCsrfToken(request));
    if (!page.signedIn || !provenance || !sameReviewReader(data.expected, provenance)) return { kind: 'mismatch' };
    return { kind: 'ready', page, provenance };
  });

export const changeRealmMembership = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<MembershipResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return await requestRealmMembership(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    } catch {
      return { outcome: 'refused' };
    }
  });

export const addRealmMember = createServerFn({ method: 'POST' })
  .validator(validateMemberAddition)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return requestRealmMemberAddition(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readRealmClaimState = createServerFn({ method: 'GET' })
  .validator(validateRealm)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readRealmClaim(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readOwnRealmClaimStatus = createServerFn({ method: 'GET' })
  .validator((input: RealmClaimStatusInput) => validateRealmClaimStatusRead(input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readRealmClaimStatus(kernelClient(), getRequest(), env as RealmClaimStatusEnv, data);
  });

export const submitRealmClaim = createServerFn({ method: 'POST' })
  .validator((input: RealmClaimInput) => validateRealmClaimInput(input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return writeRealmClaim(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

async function setupCredential() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  if (!authorization) throw new Error('Sign in to set up a community');
  return authorization;
}

/** Prepare one read credential and report only the subject proven by that same request. */
async function setupReadPreparation() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const subject = sessionSubject(request);
  const reader: SetupReaderProvenance = authorization && subject ? { kind: 'session', subject } : { kind: 'unbound' };
  return { authorization, reader, request };
}

function withSetupReader<T extends object>(
  result: T,
  reader: SetupReaderProvenance,
): T & { reader: SetupReaderProvenance } {
  return { ...result, reader };
}

function setupReadDenied(reader: SetupReaderProvenance): SetupFailure {
  return withSetupReader({ kind: 'failure', reason: 'denied', status: 401 } as const, reader);
}

async function lifecycleAdapter() {
  const authorization = await setupCredential();
  return nativeContainerLifecycleAdapter(kernelClient(), authorization, requestLocale() ?? 'en');
}

export const readContainerLifecycle = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(lifecycleReadSchema, input))
  .handler(async ({ data }) => (await lifecycleAdapter()).read(data.target, data.contextId));

export const changeContainerLifecycle = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(lifecycleCommandSchema, input))
  .handler(async ({ data }) => (await lifecycleAdapter()).change(data));

export const readContainerLifecycleDestination = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(lifecycleDestinationSchema, input))
  .handler(async ({ data }) => (await lifecycleAdapter()).destination(data.target, data.contextId));

export const readSpaceSetup = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(setupReadSchema, input))
  .handler(async ({ data }) => {
    const prepared = await setupReadPreparation();
    const result = prepared.authorization
      ? await readSetup(kernelClient(), prepared.authorization, data.spaceId)
      : setupReadDenied(prepared.reader);
    return withSetupReader(result, prepared.reader);
  });

export const resolveSpaceSetupChoice = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(setupChoiceSchema, input))
  .handler(async ({ data }) => {
    const prepared = await setupReadPreparation();
    const result = prepared.authorization
      ? await readSetupChoice(kernelClient(), prepared.authorization, data, requestLocale() ?? 'en')
      : setupReadDenied(prepared.reader);
    return withSetupReader(result, prepared.reader);
  });

export const searchSpaceSetupContexts = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(setupContextDirectorySchema, input))
  .handler(async ({ data }) => {
    const prepared = await setupReadPreparation();
    const result = prepared.authorization
      ? await readSetupContextDirectory(kernelClient().contexts, prepared.authorization, {
          query: data.query,
          ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
          signal: prepared.request.signal,
        })
      : { kind: 'denied' as const };
    return withSetupReader(result, prepared.reader);
  });

export const readSpaceSetupBoardChoices = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(boardChoiceReadSchema, input))
  .handler(async ({ data }) => {
    const prepared = await setupReadPreparation();
    const result = await readNativeBoardChoices(
      kernelClient(data.locale),
      prepared.authorization,
      requestLanguages(data.locale),
      data,
    );
    return withSetupReader(result, prepared.reader);
  });

export const changeSpaceSetup = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(setupCommandSchema, input))
  .handler(async ({ data }) => commandSetup(kernelClient(), await setupCredential(), data));

function validateShelf(input: unknown) {
  return { ...validateRealm(input), ...validateCursor(input) };
}

export const readRealmBoards = createServerFn({ method: 'GET' })
  .validator(validateShelf)
  .handler(async ({ data }): Promise<ShelfPage<RealmBoard> & { readerOrigin: ReaderOrigin }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const result = await loadRealmShelfPageWithOrigin(kernelClient(), request, env as Partial<SessionEnv>, {
      ...data,
      list: 'boards',
      languages: requestLanguages(requestLocale(request) ?? 'en'),
    });
    return { ...result.value, readerOrigin: result.readerOrigin };
  });

export const readRealmPublications = createServerFn({ method: 'GET' })
  .validator(validateShelf)
  .handler(async ({ data }): Promise<ShelfPage<PublishedSubject> & { readerOrigin: ReaderOrigin }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const result = await loadRealmShelfPageWithOrigin(kernelClient(), request, env as Partial<SessionEnv>, {
      ...data,
      list: 'publications',
      languages: requestLanguages(requestLocale(request) ?? 'en'),
    });
    if (result.value.kind !== 'page') return { ...result.value, readerOrigin: result.readerOrigin };
    const { typeNames } = await import('../subject/definitions');
    const names = await typeNames(
      [...new Set(result.value.items.flatMap((subject) => subject.types.slice(0, 1)))],
      requestLocale(request) ?? 'en',
    );
    return {
      ...result.value,
      readerOrigin: result.readerOrigin,
      items: result.value.items.map((subject) => {
        const typeName = names.get(subject.types[0] ?? '');
        return { ...subject, ...(typeName ? { typeName } : {}) };
      }),
    };
  });

/** Selected work inspection uses the same private session transport as the existing commands. */
export const readRealmPublicationPreparation = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const { realmId } = validateRealm(input);
    if (
      !input ||
      typeof input !== 'object' ||
      !('subjectId' in input) ||
      typeof input.subjectId !== 'string' ||
      !idempotencyKeyPattern.test(input.subjectId)
    )
      throw new Error('Invalid Realm publication selection');
    return { realmId, subjectId: input.subjectId };
  })
  .handler(async ({ data }) => {
    const prepared = await setupReadPreparation();
    return readPublicationPreparation(kernelClient(), prepared.authorization, data, prepared.request.signal);
  });

export const changeRealmPublication = createServerFn({ method: 'POST' })
  .validator((input: unknown): PublicationChange => {
    const { realmId } = validateRealm(input);
    if (
      !input ||
      typeof input !== 'object' ||
      !('subjectId' in input) ||
      typeof input.subjectId !== 'string' ||
      !idempotencyKeyPattern.test(input.subjectId) ||
      !('action' in input) ||
      (input.action !== 'publish' && input.action !== 'withdraw' && input.action !== 'reject') ||
      !('idempotencyKey' in input) ||
      typeof input.idempotencyKey !== 'string' ||
      !idempotencyKeyPattern.test(input.idempotencyKey) ||
      ('href' in input && typeof input.href !== 'string') ||
      ('ifMatch' in input && input.ifMatch !== null && typeof input.ifMatch !== 'string') ||
      ('expectedHead' in input &&
        input.expectedHead !== undefined &&
        (typeof input.expectedHead !== 'string' || !idempotencyKeyPattern.test(input.expectedHead)))
    )
      throw new Error('Invalid Realm publication request');
    return {
      realmId,
      subjectId: input.subjectId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      ...('href' in input && typeof input.href === 'string' ? { href: input.href } : {}),
      ...('ifMatch' in input && (typeof input.ifMatch === 'string' || input.ifMatch === null)
        ? { ifMatch: input.ifMatch }
        : {}),
      ...('expectedHead' in input && typeof input.expectedHead === 'string'
        ? { expectedHead: input.expectedHead }
        : {}),
    };
  })
  .handler(async ({ data }): Promise<PublicationOutcome> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    return changePublication(kernelClient(), viewerCredential(request), data);
  });

export const readRealmBans = createServerFn({ method: 'GET' })
  .validator(validateBanRead)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadRealmBans(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const resolveRealmBanTarget = createServerFn({ method: 'GET' })
  .validator((handle: unknown) => {
    if (typeof handle !== 'string' || handle.length > 64) throw new Error('Invalid account handle');
    return handle;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadRealmBanTarget(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const changeRealmBan = createServerFn({ method: 'POST' })
  .validator(validateBanWrite)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return writeRealmBan(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const readRealmAppearanceSettings = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(realmAppearanceReadSchema, input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    return readRealmAppearance(kernelClient(), viewerCredential(request), data.realmId);
  });

export const changeRealmAppearanceSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(realmAppearanceCommandSchema, input))
  .handler(async ({ data }) => {
    return changeRealmAppearance(data, kernelClient(), await setupCredential());
  });

export const resolveRealmAppearanceChoice = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(realmAppearanceChoiceSchema, input))
  .handler(async ({ data }) => {
    return selectRealmAppearance(data, kernelClient(), await setupCredential());
  });

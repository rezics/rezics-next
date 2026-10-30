import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import * as v from 'valibot';
import { prepareSession, viewerCredential } from '../session/request';
import {
  commandSetup,
  readSetup,
  readSetupChoice,
  setupCommandSchema,
  setupReadSchema,
  setupChoiceSchema,
} from './space-setup';
import {
  requestRealmMembership,
  loadMyRealms,
  loadSpacePage,
  locateRealm,
  namePublishedTypes,
  loadRealmShelfPage,
  type Located,
  type MembershipResult,
  type MyRealmsPage,
  type SpacePageData,
} from './space';
import { changePublication, type PublicationChange, type PublicationOutcome } from './publication-controls';
import { loadRealmBans, validateBanRead, validateBanWrite, writeRealmBan } from './realm-bans';
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
import {
  readSetupContextDirectory,
  setupContextDirectorySchema,
  unavailableNativeContextDirectory,
} from './setup-context-native';
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

export const readSpacePage = createServerFn({ method: 'GET' })
  .validator(validateAddress)
  .handler(async ({ data }): Promise<SpacePageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadSpacePage(kernelClient(), request, env as Partial<SessionEnv>, data, data.credentialMode);
    return namePublishedTypes(page, requestLocale(request) ?? 'en');
  });

export const locateRealmPage = createServerFn({ method: 'GET' })
  .validator(validateRealm)
  .handler(async ({ data }): Promise<Located> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const located = await locateRealm(kernelClient(), request, env as Partial<SessionEnv>, data, data.credentialMode);
    return located.kind === 'page'
      ? { ...located, page: await namePublishedTypes(located.page, requestLocale(request) ?? 'en') }
      : located;
  });

export const readMyRealmsPage = createServerFn({ method: 'GET' })
  .validator(validateCursor)
  .handler(async ({ data }): Promise<MyRealmsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMyRealms(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const changeRealmMembership = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<MembershipResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return requestRealmMembership(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    } catch {
      return { outcome: 'refused' };
    }
  });

export const readRealmClaimState = createServerFn({ method: 'GET' })
  .validator(validateRealm)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readRealmClaim(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
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
  .handler(async ({ data }) => readSetup(kernelClient(), await setupCredential(), data.spaceId));

export const resolveSpaceSetupChoice = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(setupChoiceSchema, input))
  .handler(async ({ data }) => readSetupChoice(kernelClient(), await setupCredential(), data, requestLocale() ?? 'en'));

export const searchSpaceSetupContexts = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(setupContextDirectorySchema, input))
  .handler(async ({ data }) =>
    // Bind the original generated contexts directory here when its GET declaration is delivered.
    readSetupContextDirectory(unavailableNativeContextDirectory, await setupCredential(), {
      query: data.query,
      ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
      signal: getRequest().signal,
    }),
  );

export const readSpaceSetupBoardChoices = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(boardChoiceReadSchema, input))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    return readNativeBoardChoices(
      kernelClient(data.locale),
      viewerCredential(request),
      requestLanguages(data.locale),
      data,
    );
  });

export const changeSpaceSetup = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(setupCommandSchema, input))
  .handler(async ({ data }) => commandSetup(kernelClient(), await setupCredential(), data));

function validateShelf(input: unknown) {
  return { ...validateRealm(input), ...validateCursor(input) };
}

export const readRealmBoards = createServerFn({ method: 'GET' })
  .validator(validateShelf)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadRealmShelfPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, { ...data, list: 'boards' });
  });

export const readRealmPublications = createServerFn({ method: 'GET' })
  .validator(validateShelf)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const result = await loadRealmShelfPage(kernelClient(), request, env as Partial<SessionEnv>, {
      ...data,
      list: 'publications',
    });
    if (result.kind !== 'page') return result;
    const { typeNames } = await import('../subject/definitions');
    const names = await typeNames(
      [...new Set(result.items.flatMap((subject) => subject.types.slice(0, 1)))],
      requestLocale(request) ?? 'en',
    );
    return {
      ...result,
      items: result.items.map((subject) => {
        const typeName = names.get(subject.types[0] ?? '');
        return { ...subject, ...(typeName ? { typeName } : {}) };
      }),
    };
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

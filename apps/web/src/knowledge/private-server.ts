import {
  parseOrganizationRequest,
  readOrganization,
  moveOrganizationPlacement,
  type OrganizationReadResult,
  type OrganizationMoveResult,
} from './organization-read';
import {
  copyKnowledgeTransfer,
  exportKnowledgeTransfer,
  parseKnowledgeTransferSource,
  readKnowledgeCopy,
  type KnowledgeCopyResult,
  type KnowledgeCopyReadback,
  type KnowledgeExportResult,
} from './transfer';
import { parseDocument, type DocumentSnapshot } from '@rezics/document';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import { isSessionUnavailableError } from '../session/unavailable';
import {
  parseKnowledgeNavigationCursor,
  readKnowledgeOutline,
  readKnowledgeOwnedNotebooks,
  type KnowledgeOutlineRead,
  type KnowledgeOwnedNotebooksRead,
} from './navigation.ts';
import {
  createKnowledgePrivateDocument,
  createKnowledgePrivateNotebook,
  isKnowledgeId,
  parseKnowledgePrivateAddress,
  readKnowledgePrivateHead,
  reviseKnowledgePrivateDocument,
  type KnowledgeDocumentCommand,
  type KnowledgePrivateAddress,
  type KnowledgePrivateHead,
  type KnowledgeRevisionCommand,
} from './private-knowledge';

import { selectKnowledgePublication } from './publication';
import {
  changeKnowledgeLifecycle,
  readKnowledgeLifecycle,
  isKnowledgeLifecycleGeneration,
  type KnowledgeLifecycleRead,
} from './lifecycle';
import {
  parseKnowledgeNavigationRequest,
  readKnowledgeNavigation,
  type KnowledgeNavigationResult,
} from './navigation-read';

import {
  parseKnowledgeHistoryCursor,
  parseKnowledgeHistoryPair,
  readKnowledgeHistory,
  readKnowledgeHistoryComparison,
  type KnowledgeHistoryRead,
  type KnowledgeHistoryCompareRead,
} from './history';

const domain = 'rezics:knowledge-private-visit:v1';
const tokenPattern = /^[A-Za-z0-9_-]{1,8192}$/;
const commandKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Identity = { viewer: string; csrfToken: string; authorization: string };
type Preparation = { state: 'ready'; viewer: string; csrfToken: string; credential: string };
type ClosedIdentity = { state: 'signed-out' } | { state: 'unavailable'; status?: number } | { state: 'retired' };
export type KnowledgePrivatePreparation = Preparation | { state: 'signed-out' | 'unavailable' | 'retired' };
export type KnowledgePrivateVisitRead =
  | { state: 'ready'; viewer: string; csrfToken: string; credential: string; head: KnowledgePrivateHead }
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'not-found'; status: 404 }
  | { state: 'unavailable'; status: number }
  | { state: 'signed-out' | 'retired' };

async function currentIdentity(): Promise<Identity | 'signed-out' | 'unavailable'> {
  const request = getRequest();
  try {
    await prepareSession(request, env as Partial<SessionEnv>);
    const viewer = sessionSubject(request);
    const authorization = viewerCredential(request);
    const csrfToken = requestCsrfToken(request);
    if (!viewer || !authorization || !csrfToken) return 'signed-out';
    return { viewer, authorization, csrfToken };
  } catch (error) {
    if (isSessionUnavailableError(error)) return 'unavailable';
    throw error;
  }
}

function boundIdentity(value: unknown): { viewer: string; csrfToken: string } | null {
  if (!record(value) || typeof value.viewer !== 'string' || !value.viewer || typeof value.csrfToken !== 'string')
    return null;
  return { viewer: value.viewer, csrfToken: value.csrfToken };
}

function currentFor(
  expected: { viewer: string; csrfToken: string },
  current: Identity | 'signed-out' | 'unavailable',
): Identity | ClosedIdentity {
  if (current === 'unavailable') return { state: 'unavailable' };
  if (current === 'signed-out') return { state: 'signed-out' };
  if (current.viewer !== expected.viewer || current.csrfToken !== expected.csrfToken) return { state: 'retired' };
  return current;
}

function envContext(environment: Partial<SessionEnv>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([domain, environment.AUTH_ISSUER, environment.API_RESOURCE, environment.WEBSITE_CLIENT_ID]),
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function encryptionKey(environment: Partial<SessionEnv>): Promise<CryptoKey> {
  if (!environment.WEBSITE_CLIENT_KEY) throw new Error('Missing Web credential key');
  const raw = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${domain}\n${environment.WEBSITE_CLIENT_KEY}`),
  );
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function tokenOf(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesOf(token: string): Uint8Array {
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) =>
    character.charCodeAt(0),
  );
}

async function captureCredential(request: Request, identity: Identity): Promise<string> {
  const sessionId = cookie(request, SESSION_COOKIE);
  if (!sessionId) throw new Error('Missing signed-in session cookie');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      binding: [new URL(request.url).origin, sessionId, identity.viewer],
      viewer: identity.viewer,
      csrfToken: identity.csrfToken,
      authorization: identity.authorization,
    }),
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(iv),
        additionalData: arrayBuffer(envContext(env as Partial<SessionEnv>)),
      },
      await encryptionKey(env as Partial<SessionEnv>),
      arrayBuffer(plaintext),
    ),
  );
  const token = tokenOf(new Uint8Array([...iv, ...encrypted]));
  if (!tokenPattern.test(token)) throw new Error('Knowledge session credential exceeds form bound');
  return token;
}

async function originalCredential(request: Request, identity: Identity, token: string): Promise<string | null> {
  if (!tokenPattern.test(token)) return null;
  try {
    const bytes = bytesOf(token);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: arrayBuffer(bytes.slice(0, 12)),
        additionalData: arrayBuffer(envContext(env as Partial<SessionEnv>)),
      },
      await encryptionKey(env as Partial<SessionEnv>),
      arrayBuffer(bytes.slice(12)),
    );
    const captured = JSON.parse(new TextDecoder().decode(plaintext)) as {
      binding: unknown;
      viewer: string;
      csrfToken: string;
      authorization: string;
    };
    const sessionId = cookie(request, SESSION_COOKIE);
    const binding = [new URL(request.url).origin, sessionId, identity.viewer];
    return sessionId &&
      captured.viewer === identity.viewer &&
      captured.csrfToken === identity.csrfToken &&
      JSON.stringify(captured.binding) === JSON.stringify(binding) &&
      typeof captured.authorization === 'string'
      ? captured.authorization
      : null;
  } catch {
    return null;
  }
}

function expectedViewer(value: unknown): string {
  if (typeof value !== 'string' || !isKnowledgeId(value)) throw new Error('Invalid Knowledge viewer');
  return value;
}

function expectedSession(value: unknown) {
  const expected = boundIdentity(value);
  if (!expected || !isKnowledgeId(expected.viewer) || !expected.csrfToken)
    throw new Error('Invalid Knowledge session binding');
  return expected;
}

function address(value: unknown): KnowledgePrivateAddress {
  const parsed = parseKnowledgePrivateAddress(value);
  if (!parsed) throw new Error('Invalid private Knowledge address');
  return parsed;
}

function boundedText(value: unknown, maximum: number, label: string, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum)
    throw new Error(`Invalid Knowledge ${label}`);
  return value;
}

function boundedId(value: unknown, label: string): string {
  if (!isKnowledgeId(value)) throw new Error(`Invalid Knowledge ${label}`);
  return value;
}

function language(value: unknown): string | null {
  if (value === null) return null;
  return boundedText(value, 64, 'language');
}

function documentBody(value: unknown): DocumentSnapshot {
  try {
    return parseDocument(value);
  } catch {
    throw new Error('Invalid Knowledge document body');
  }
}

function commandKey(value: unknown): string {
  if (typeof value !== 'string' || !commandKeyPattern.test(value)) throw new Error('Invalid Knowledge command key');
  return value;
}

function credential(value: unknown): string {
  if (typeof value !== 'string' || !tokenPattern.test(value)) throw new Error('Invalid Knowledge command credential');
  return value;
}

export const prepareKnowledgePrivateVisit = createServerFn({ method: 'GET' })
  .validator((value: unknown) => {
    if (!record(value) || !isKnowledgeId(value.subjectId)) throw new Error('Invalid Knowledge Subject');
    return { subjectId: value.subjectId, expectedViewer: expectedViewer(value.expectedViewer) };
  })
  .handler(async ({ data }): Promise<KnowledgePrivatePreparation> => {
    setResponseHeader('cache-control', 'private, no-store');
    const current = await currentIdentity();
    if (current === 'unavailable' || current === 'signed-out') return { state: current };
    if (current.viewer !== data.expectedViewer) return { state: 'retired' };
    const identity = current;
    try {
      const token = await captureCredential(getRequest(), identity);
      return { state: 'ready', viewer: identity.viewer, csrfToken: identity.csrfToken, credential: token };
    } catch {
      return { state: 'unavailable' };
    }
  });

export const readKnowledgePrivateVisit = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid private Knowledge read');
    return { address: address(value.address), expected: expectedSession(value.expected) };
  })
  .handler(async ({ data }): Promise<KnowledgePrivateVisitRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) {
      return identity.state === 'unavailable' ? { state: 'unavailable', status: 503 } : { state: identity.state };
    }
    try {
      const result = await readKnowledgePrivateHead(kernelClient(), {
        ...data.address,
        accountId: identity.viewer,
        authorization: identity.authorization,
      });
      if (result.state !== 'ready') return result;
      const token = await captureCredential(getRequest(), identity);
      return {
        state: 'ready',
        viewer: identity.viewer,
        csrfToken: identity.csrfToken,
        credential: token,
        head: result.head,
      };
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable', status: 503 };
      return { state: 'unavailable', status: 503 };
    }
  });

type CommandBinding = { viewer: string; csrfToken: string; credential: string; idempotencyKey: string };

async function commandIdentity(binding: CommandBinding): Promise<Identity | ClosedIdentity> {
  const identity = currentFor(binding, await currentIdentity());
  if ('state' in identity) return identity;
  const authorization = await originalCredential(getRequest(), identity, binding.credential);
  return authorization ? { ...identity, authorization } : { state: 'retired' };
}

function commandBinding(value: Record<string, unknown>): CommandBinding {
  const expected = expectedSession(value);
  return {
    ...expected,
    credential: credential(value.credential),
    idempotencyKey: commandKey(value.idempotencyKey),
  };
}

export const readKnowledgeLifecycleVisit = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge lifecycle read');
    return { address: address(value.address), expected: expectedSession(value.expected) };
  })
  .handler(async ({ data }): Promise<KnowledgeLifecycleRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return identity.state === 'unavailable' ? { state: 'unavailable', status: 503 } : identity;
    try {
      const result = await readKnowledgeLifecycle(kernelClient(), {
        ...data.address,
        accountId: identity.viewer,
        authorization: identity.authorization,
      });
      if (result.state !== 'ready') return result;
      return {
        ...result,
        binding: {
          viewer: identity.viewer,
          csrfToken: identity.csrfToken,
          credential: await captureCredential(getRequest(), identity),
        },
      };
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable', status: 503 };
      throw error;
    }
  });

export const changeKnowledgeLifecycleRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (
      !record(value) ||
      !(value.action === 'trash' || value.action === 'restore') ||
      !isKnowledgeLifecycleGeneration(value.expectedGeneration)
    )
      throw new Error('Invalid Knowledge lifecycle command');
    return {
      address: address(value.address),
      action: value.action,
      expectedStructureRevisionId: boundedId(value.expectedStructureRevisionId, 'structure revision'),
      expectedGeneration: value.expectedGeneration,
      binding: commandBinding(value),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data.binding);
    if ('state' in identity) return identity;
    try {
      return await changeKnowledgeLifecycle(kernelClient(), {
        ...data,
        idempotencyKey: data.binding.idempotencyKey,
        authorization: identity.authorization,
      });
    } catch (error) {
      return isPlatformClosedError(error) ? { state: 'unavailable', status: 503 } : { state: 'uncertain' as const };
    }
  });

export const createKnowledgePrivateNotebookRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value) || !isKnowledgeId(value.subjectId)) throw new Error('Invalid Knowledge notebook command');
    return {
      subjectId: value.subjectId,
      title: boundedText(value.title, 256, 'notebook title'),
      binding: commandBinding(value),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data.binding);
    if ('state' in identity) return identity;
    try {
      return await createKnowledgePrivateNotebook(kernelClient(), {
        subjectId: data.subjectId,
        title: data.title,
        idempotencyKey: data.binding.idempotencyKey,
        authorization: identity.authorization,
      });
    } catch (error) {
      return isPlatformClosedError(error) ? { state: 'unavailable', status: 503 } : { state: 'uncertain' };
    }
  });

function parentPlacement(value: unknown): string | null {
  if (value === null) return null;
  return boundedId(value, 'parent placement');
}

function navigationCursor(value: unknown): string | null {
  const parsed = parseKnowledgeNavigationCursor(value);
  if (parsed === undefined) throw new Error('Invalid Knowledge navigation cursor');
  return parsed;
}

function createDocumentInput(value: unknown): Omit<KnowledgeDocumentCommand, 'authorization'> & {
  viewer: string;
  csrfToken: string;
  credential: string;
} {
  if (!record(value) || !isKnowledgeId(value.subjectId) || !isKnowledgeId(value.notebookId))
    throw new Error('Invalid Knowledge document command');
  const expected = expectedSession(value);
  return {
    ...expected,
    credential: credential(value.credential),
    idempotencyKey: commandKey(value.idempotencyKey),
    subjectId: value.subjectId,
    notebookId: value.notebookId,
    structureRevisionId: boundedId(value.structureRevisionId, 'structure revision'),
    parentPlacementId: parentPlacement(value.parentPlacementId),
    title: boundedText(value.title, 512, 'document title'),
    language: language(value.language),
    body: documentBody(value.body),
    licence: boundedText(value.licence, 128, 'licence'),
  };
}

export const readKnowledgeOwnedNotebooksRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge notebook inventory read');
    return { expected: expectedSession(value), cursor: navigationCursor(value.cursor) };
  })
  .handler(async ({ data }): Promise<KnowledgeOwnedNotebooksRead | ClosedIdentity> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return identity;
    try {
      return await readKnowledgeOwnedNotebooks(kernelClient(), {
        accountId: identity.viewer,
        cursor: data.cursor,
        authorization: identity.authorization,
      });
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable', status: 503 };
      return { state: 'unavailable', status: 503 };
    }
  });

export const readKnowledgeOutlineRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value) || !isKnowledgeId(value.notebookId)) throw new Error('Invalid Knowledge outline read');
    return {
      expected: expectedSession(value),
      notebookId: value.notebookId,
      parentPlacementId: parentPlacement(value.parentPlacementId),
      cursor: navigationCursor(value.cursor),
    };
  })
  .handler(async ({ data }): Promise<KnowledgeOutlineRead | ClosedIdentity> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return identity;
    try {
      return await readKnowledgeOutline(kernelClient(), {
        accountId: identity.viewer,
        notebookId: data.notebookId,
        parentPlacementId: data.parentPlacementId,
        cursor: data.cursor,
        authorization: identity.authorization,
      });
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable', status: 503 };
      return { state: 'unavailable', status: 503 };
    }
  });

export const createKnowledgePrivateDocumentRequest = createServerFn({ method: 'POST' })
  .validator(createDocumentInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data);
    if ('state' in identity) return identity;
    try {
      return await createKnowledgePrivateDocument(kernelClient(), { ...data, authorization: identity.authorization });
    } catch (error) {
      return isPlatformClosedError(error) ? { state: 'unavailable', status: 503 } : { state: 'uncertain' };
    }
  });

function reviseInput(value: unknown): Omit<KnowledgeRevisionCommand, 'authorization'> & {
  viewer: string;
  csrfToken: string;
  credential: string;
} {
  if (!record(value) || !isKnowledgeId(value.documentId)) throw new Error('Invalid Knowledge revision command');
  const expected = expectedSession(value);
  if (!Array.isArray(value.subjectIds) || value.subjectIds.length > 64 || !value.subjectIds.every(isKnowledgeId))
    throw new Error('Invalid Knowledge revision subjects');
  return {
    ...expected,
    credential: credential(value.credential),
    idempotencyKey: commandKey(value.idempotencyKey),
    documentId: value.documentId,
    expectedHeadRevisionId: boundedId(value.expectedHeadRevisionId, 'head revision'),
    title: boundedText(value.title, 512, 'document title'),
    language: language(value.language),
    body: documentBody(value.body),
    licence: boundedText(value.licence, 128, 'licence'),
    subjectIds: [...value.subjectIds],
  };
}

export const reviseKnowledgePrivateDocumentRequest = createServerFn({ method: 'POST' })
  .validator(reviseInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data);
    if ('state' in identity) return identity;
    try {
      return await reviseKnowledgePrivateDocument(kernelClient(), { ...data, authorization: identity.authorization });
    } catch (error) {
      return isPlatformClosedError(error) ? { state: 'unavailable', status: 503 } : { state: 'uncertain' };
    }
  });

/** The existing prepared-session binding also fences publication and exact replay. */
export const selectKnowledgePublicationRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge publication command');
    return {
      ...commandBinding(value),
      documentId: boundedId(value.documentId, 'document'),
      expectedHeadRevisionId: boundedId(value.expectedHeadRevisionId, 'head revision'),
      expectedPublicationId:
        value.expectedPublicationId === null ? null : boundedId(value.expectedPublicationId, 'publication'),
      revisionId: value.revisionId === null ? null : boundedId(value.revisionId, 'selected revision'),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data);
    if ('state' in identity) return identity;
    try {
      return await selectKnowledgePublication(kernelClient(), { ...data, authorization: identity.authorization });
    } catch (error) {
      return isPlatformClosedError(error) ? { state: 'unavailable', status: 503 } : { state: 'uncertain' };
    }
  });

/** Private navigation shares the editor's prepared session and exact CSRF/viewer admission. */
export const readKnowledgeNavigationVisit = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge navigation read');
    const request = parseKnowledgeNavigationRequest(value.request);
    if (!request) throw new Error('Invalid Knowledge navigation address');
    return { request, expected: expectedSession(value.expected) };
  })
  .handler(async ({ data }): Promise<KnowledgeNavigationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return { state: identity.state };
    try {
      return await readKnowledgeNavigation(kernelClient(), {
        request: data.request,
        accountId: identity.viewer,
        authorization: identity.authorization,
      });
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable' };
      throw error;
    }
  });

/** Explicit private history reads use the prepared viewer, never an account supplied by the browser. */
export const readKnowledgeHistoryVisit = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge history read');
    const cursor = parseKnowledgeHistoryCursor(value.cursor);
    if (cursor === undefined) throw new Error('Invalid Knowledge history cursor');
    return { address: address(value.address), expected: expectedSession(value.expected), cursor };
  })
  .handler(async ({ data }): Promise<KnowledgeHistoryRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return identity;
    try {
      return await readKnowledgeHistory(kernelClient(), {
        ...data.address,
        cursor: data.cursor,
        accountId: identity.viewer,
        authorization: identity.authorization,
      });
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable', status: 503 };
      throw error;
    }
  });

export const readKnowledgeHistoryComparisonVisit = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge comparison read');
    const pair = parseKnowledgeHistoryPair(value.pair);
    if (!pair) throw new Error('Invalid Knowledge comparison pair');
    return { address: address(value.address), expected: expectedSession(value.expected), pair };
  })
  .handler(async ({ data }): Promise<KnowledgeHistoryCompareRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return identity;
    try {
      return await readKnowledgeHistoryComparison(kernelClient(), {
        ...data.address,
        ...data.pair,
        accountId: identity.viewer,
        authorization: identity.authorization,
      });
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable', status: 503 };
      throw error;
    }
  });

/** Transfer reuses the editor's prepared-session envelope and original command credential. */
export const exportKnowledgeOwnTransferRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge export');
    const source = parseKnowledgeTransferSource(value.source);
    if (!source || source.representation !== 'authoring') throw new Error('Invalid Knowledge authoring source');
    return { source, expected: expectedSession(value.expected) };
  })
  .handler(async ({ data }): Promise<KnowledgeExportResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return { state: identity.state };
    if (data.source.accountId !== identity.viewer) return { state: 'retired' };
    return exportKnowledgeTransfer(
      (decorate) => kernelClient(undefined, undefined, decorate),
      data.source,
      identity.authorization,
    );
  });

export const prepareKnowledgeTransferRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge transfer preparation');
    return expectedSession(value);
  })
  .handler(async ({ data }): Promise<KnowledgePrivatePreparation> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data, await currentIdentity());
    if ('state' in identity) return { state: identity.state };
    return {
      state: 'ready',
      viewer: identity.viewer,
      csrfToken: identity.csrfToken,
      credential: await captureCredential(getRequest(), identity),
    };
  });

export const copyKnowledgeTransferRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge copy command');
    const source = parseKnowledgeTransferSource(value.source);
    if (!source) throw new Error('Invalid Knowledge copy source');
    return {
      source,
      notebookId: boundedId(value.notebookId, 'destination notebook'),
      expectedStructureRevisionId: boundedId(value.expectedStructureRevisionId, 'structure revision'),
      parentPlacementId: parentPlacement(value.parentPlacementId),
      binding: commandBinding(value),
    };
  })
  .handler(async ({ data }): Promise<KnowledgeCopyResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data.binding);
    if ('state' in identity) return { state: identity.state };
    try {
      return await copyKnowledgeTransfer(
        kernelClient(),
        { ...data, idempotencyKey: data.binding.idempotencyKey },
        identity.authorization,
      );
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable' };
      // The POST may have committed before its transport failed. Only exact explicit replay can resolve it.
      return { state: 'uncertain' };
    }
  });

export const readKnowledgeCopyRequest = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value) || !record(value.receipt)) throw new Error('Invalid Knowledge copy readback');
    const receipt = value.receipt;
    return {
      expected: expectedSession(value.expected),
      receipt: {
        notebookId: boundedId(receipt.notebookId, 'notebook'),
        documentId: boundedId(receipt.documentId, 'document'),
        revisionId: boundedId(receipt.revisionId, 'revision'),
        placementId: boundedId(receipt.placementId, 'placement'),
        structureRevisionId: boundedId(receipt.structureRevisionId, 'structure revision'),
      },
    };
  })
  .handler(async ({ data }): Promise<KnowledgeCopyReadback> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return { state: identity.state };
    return readKnowledgeCopy(kernelClient(), data.receipt, identity.viewer, identity.authorization);
  });

export const prepareKnowledgeOrganizationVisit = createServerFn({ method: 'POST' })
  .validator(expectedSession)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data, await currentIdentity());
    if ('state' in identity) return { state: identity.state };
    return {
      state: 'ready' as const,
      binding: {
        viewer: identity.viewer,
        csrfToken: identity.csrfToken,
        credential: await captureCredential(getRequest(), identity),
      },
    };
  });

export const readKnowledgeOrganizationVisit = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value)) throw new Error('Invalid Knowledge organization read');
    const request = parseOrganizationRequest(value.request);
    if (!request) throw new Error('Invalid Knowledge organization address');
    return { request, expected: expectedSession(value.expected) };
  })
  .handler(async ({ data }): Promise<OrganizationReadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = currentFor(data.expected, await currentIdentity());
    if ('state' in identity) return { state: identity.state };
    try {
      return await readOrganization(kernelClient(), {
        request: data.request,
        accountId: identity.viewer,
        authorization: identity.authorization,
      });
    } catch (error) {
      if (isPlatformClosedError(error)) return { state: 'unavailable' };
      throw error;
    }
  });

export const moveKnowledgeOrganizationPlacement = createServerFn({ method: 'POST' })
  .validator((value: unknown) => {
    if (!record(value) || !record(value.binding)) throw new Error('Invalid Knowledge move');
    return {
      notebookId: boundedId(value.notebookId, 'notebook'),
      placementId: boundedId(value.placementId, 'placement'),
      expectedStructureRevisionId: boundedId(value.expectedStructureRevisionId, 'structure revision'),
      destinationParentPlacementId: parentPlacement(value.destinationParentPlacementId),
      beforePlacementId: parentPlacement(value.beforePlacementId),
      binding: commandBinding({ ...value.binding, idempotencyKey: value.idempotencyKey }),
    };
  })
  .handler(async ({ data }): Promise<OrganizationMoveResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await commandIdentity(data.binding);
    if ('state' in identity) return { state: identity.state };
    try {
      return await moveOrganizationPlacement(kernelClient(), {
        ...data,
        idempotencyKey: data.binding.idempotencyKey,
        authorization: identity.authorization,
      });
    } catch (error) {
      return isPlatformClosedError(error) ? { state: 'unavailable' } : { state: 'uncertain' };
    }
  });

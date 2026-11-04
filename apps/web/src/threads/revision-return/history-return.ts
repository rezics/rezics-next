import type { ReadCredentialMode } from '../../kernel/credential';
import type { ExactRevisionIdentity } from '../exact-revision';
import type { HistoricalReaderSource } from '../historical-reader-provenance';

const maxHistoryRows = 100;
const maxCursorLength = 4096;
const maxIdentityLength = 128;
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HistoryReturnIntent = {
  token: string;
  postId: string;
  revisionId: string;
};

export type HistoryReturnTarget = {
  token: string;
  postId: string;
  revisionId: string;
  locale: string;
  threadId: string;
  slug: string;
  threadCursor?: string;
  historyCursor?: string;
  readerId: number;
  pageGeneration: number;
};

type Origin = {
  threadId: string;
  slug: string;
  threadCursor?: string;
};

type Receipt = HistoryReturnTarget & {
  source: HistoricalReaderSource;
  sourceId: string;
  sourceGeneration: number;
  credentialMode: ReadCredentialMode;
};

type ReturnCommand = HistoryReturnIntent & { focusRequested: boolean };

// This slot is deliberately bounded to the current admitted history page.
let currentReceipt: Receipt | undefined;
let pendingCommand: ReturnCommand | undefined;

export function parseHistoryReturnToken(value: unknown): string | undefined {
  return typeof value === 'string' && tokenPattern.test(value) ? value : undefined;
}

export function parseHistoryReturnIntent(search: string): HistoryReturnIntent | undefined {
  const values = new URLSearchParams(search);
  const token = parseHistoryReturnToken(values.get('historyReturn'));
  const postId = values.get('post');
  const revisionId = values.get('historyRevision');
  if (
    !token ||
    !postId ||
    postId.length > maxIdentityLength ||
    !revisionId ||
    revisionId.length > maxIdentityLength
  )
    return undefined;
  return { token, postId, revisionId };
}

function decodeSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= maxIdentityLength && !/[\\/\u0000-\u001f]/.test(decoded)
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function currentThreadOrigin(pathname: string, search: string, locale: string): Origin | undefined {
  if (!pathname.startsWith(`/${encodeURIComponent(locale)}/threads/`) || pathname.startsWith('//')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(pathname, 'https://rezics.invalid');
  } catch {
    return undefined;
  }
  if (parsed.origin !== 'https://rezics.invalid' || parsed.pathname !== pathname) return undefined;
  const segments = pathname.split('/');
  if (segments.length !== 5 || segments[1] !== encodeURIComponent(locale) || segments[2] !== 'threads') return undefined;
  const threadId = decodeSegment(segments[3]!);
  const slug = decodeSegment(segments[4]!);
  if (!threadId || !slug || threadId === '.' || threadId === '..' || slug === '.' || slug === '..') return undefined;
  const cursor = new URLSearchParams(search).get('cursor');
  if (cursor !== null && cursor.length > maxCursorLength) return undefined;
  return {
    threadId,
    slug,
    ...(cursor !== null ? { threadCursor: cursor } : {}),
  };
}

function readerCompatible(mode: ReadCredentialMode, source: HistoricalReaderSource): boolean {
  const observation = source.read();
  return (
    observation.healthy &&
    observation.credentialMode === mode &&
    (mode === 'session'
      ? observation.state === 'signed-in' && typeof observation.subject === 'string' && observation.subject.length > 0
      : observation.state !== 'signed-in')
  );
}

export function createHistoryReturnReceipt(input: {
  postId: string;
  revisionId: string;
  locale: string;
  credentialMode: ReadCredentialMode;
  source: HistoricalReaderSource | undefined;
  readerId: number;
  pageGeneration: number;
  historyCursor: string | undefined;
  revisionIds: readonly string[];
  pathname: string;
  search: string;
}): string | undefined {
  const { source } = input;
  const revisionIds = [...new Set(input.revisionIds)];
  if (
    !source ||
    !input.postId ||
    input.postId.length > maxIdentityLength ||
    !input.revisionId ||
    input.revisionId.length > maxIdentityLength ||
    !Number.isSafeInteger(input.readerId) ||
    input.readerId < 1 ||
    !Number.isSafeInteger(input.pageGeneration) ||
    input.pageGeneration < 1 ||
    revisionIds.length === 0 ||
    revisionIds.length > maxHistoryRows ||
    revisionIds.some((id) => !id || id.length > maxIdentityLength) ||
    !revisionIds.includes(input.revisionId) ||
    (input.historyCursor !== undefined && input.historyCursor.length > maxCursorLength) ||
    !readerCompatible(input.credentialMode, source)
  )
    return undefined;

  const origin = currentThreadOrigin(input.pathname, input.search, input.locale);
  const observation = source.read();
  const sourceGeneration = source.revision();
  if (!origin || observation.sourceId !== source.id || observation.generation !== sourceGeneration) return undefined;

  const token = globalThis.crypto?.randomUUID?.();
  if (!token) return undefined;
  currentReceipt = {
    token,
    postId: input.postId,
    revisionId: input.revisionId,
    locale: input.locale,
    ...origin,
    ...(input.historyCursor !== undefined ? { historyCursor: input.historyCursor } : {}),
    readerId: input.readerId,
    pageGeneration: input.pageGeneration,
    source,
    sourceId: source.id,
    sourceGeneration,
    credentialMode: input.credentialMode,
  };
  pendingCommand = undefined;
  return token;
}

function retire(token: string) {
  if (currentReceipt?.token !== token) return;
  currentReceipt = undefined;
  if (pendingCommand?.token === token) pendingCommand = undefined;
}

export function retireHistoryReturnReceipt(token: string) {
  retire(token);
}

/** Route departure retires the receipt unless the one-shot return command currently owns it. */
export function retireHistoryReturnReceiptOnDeparture(token: string | undefined) {
  if (!token || currentReceipt?.token !== token || pendingCommand?.token === token) return;
  retire(token);
}

function current(receipt: Receipt, source: HistoricalReaderSource | undefined, locale: string, mode: ReadCredentialMode) {
  if (
    !source ||
    source !== receipt.source ||
    source.id !== receipt.sourceId ||
    source.revision() !== receipt.sourceGeneration ||
    locale !== receipt.locale ||
    mode !== receipt.credentialMode
  )
    return false;
  const observation = source.read();
  return (
    observation.healthy &&
    observation.sourceId === receipt.sourceId &&
    observation.generation === receipt.sourceGeneration &&
    readerCompatible(mode, source)
  );
}

function target(receipt: Receipt): HistoryReturnTarget {
  return {
    token: receipt.token,
    postId: receipt.postId,
    revisionId: receipt.revisionId,
    locale: receipt.locale,
    threadId: receipt.threadId,
    slug: receipt.slug,
    ...(receipt.threadCursor !== undefined ? { threadCursor: receipt.threadCursor } : {}),
    ...(receipt.historyCursor !== undefined ? { historyCursor: receipt.historyCursor } : {}),
    readerId: receipt.readerId,
    pageGeneration: receipt.pageGeneration,
  };
}

export function resolveHistoryReturnTarget(
  token: string | undefined,
  identity: ExactRevisionIdentity,
  locale: string,
  credentialMode: ReadCredentialMode,
  source: HistoricalReaderSource | undefined,
): HistoryReturnTarget | undefined {
  if (!token || currentReceipt?.token !== token) return undefined;
  const receipt = currentReceipt;
  if (
    receipt.postId !== identity.postId ||
    receipt.revisionId !== identity.revisionId ||
    receipt.locale !== locale ||
    !current(receipt, source, locale, credentialMode)
  ) {
    retire(token);
    return undefined;
  }
  return target(receipt);
}

export function historyReturnTargetCurrent(
  value: HistoryReturnTarget,
  postId: string,
  revisionId: string,
  locale: string,
  credentialMode: ReadCredentialMode,
  source: HistoricalReaderSource | undefined,
  pathname: string,
  search: string,
): boolean {
  const receipt = currentReceipt;
  if (!receipt || receipt.token !== value.token) return false;
  const origin = currentThreadOrigin(pathname, search, locale);
  if (!origin) {
    retire(value.token);
    return false;
  }
  const valid =
    value.locale === receipt.locale &&
    receipt.postId === postId &&
    value.postId === postId &&
    value.revisionId === revisionId &&
    receipt.revisionId === revisionId &&
    value.threadId === receipt.threadId &&
    value.slug === receipt.slug &&
    value.threadCursor === receipt.threadCursor &&
    value.historyCursor === receipt.historyCursor &&
    value.readerId === receipt.readerId &&
    value.pageGeneration === receipt.pageGeneration &&
    origin.threadId === value.threadId &&
    origin.slug === value.slug &&
    origin.threadCursor === value.threadCursor &&
    current(receipt, source, locale, credentialMode);
  if (!valid) retire(value.token);
  return valid;
}

export function markHistoryReturnCommand(
  value: HistoryReturnTarget,
  revisionId: string,
  focusRequested: boolean,
): boolean {
  const receipt = currentReceipt;
  if (
    !receipt ||
    receipt.token !== value.token ||
    receipt.postId !== value.postId ||
    receipt.revisionId !== value.revisionId ||
    receipt.locale !== value.locale ||
    receipt.threadId !== value.threadId ||
    receipt.slug !== value.slug ||
    receipt.threadCursor !== value.threadCursor ||
    receipt.historyCursor !== value.historyCursor ||
    receipt.readerId !== value.readerId ||
    receipt.pageGeneration !== value.pageGeneration ||
    value.revisionId !== revisionId ||
    receipt.revisionId !== revisionId ||
    !current(receipt, receipt.source, receipt.locale, receipt.credentialMode)
  )
    return false;
  pendingCommand = { token: receipt.token, postId: receipt.postId, revisionId, focusRequested };
  return true;
}

export function consumeHistoryReturnCommand(input: {
  intent: HistoryReturnIntent;
  locale: string;
  credentialMode: ReadCredentialMode;
  source: HistoricalReaderSource | undefined;
  pathname: string;
  search: string;
}): { target: HistoryReturnTarget; focusRequested: boolean } | undefined {
  const receipt = currentReceipt;
  const command = pendingCommand;
  const origin = currentThreadOrigin(input.pathname, input.search, input.locale);
  if (
    !receipt ||
    !command ||
    command.token !== input.intent.token ||
    command.postId !== input.intent.postId ||
    command.revisionId !== input.intent.revisionId ||
    receipt.token !== input.intent.token ||
    receipt.token !== command.token ||
    receipt.postId !== input.intent.postId ||
    receipt.revisionId !== input.intent.revisionId ||
    !origin ||
    origin.threadId !== receipt.threadId ||
    origin.slug !== receipt.slug ||
    origin.threadCursor !== receipt.threadCursor ||
    new URLSearchParams(input.search).get('post') !== receipt.postId ||
    !current(receipt, input.source, input.locale, input.credentialMode)
  ) {
    console.error('History return command was rejected', {
      receiptToken: receipt?.token,
      intent: input.intent,
      command,
      origin,
      pathname: input.pathname,
      search: input.search,
      sourceMatches: receipt?.source === input.source,
      sourceCurrent: receipt
        ? current(receipt, input.source, input.locale, input.credentialMode)
        : false,
    });
    pendingCommand = undefined;
    if (receipt?.token === input.intent.token) retire(input.intent.token);
    return undefined;
  }
  pendingCommand = undefined;
  return { target: target(receipt), focusRequested: command.focusRequested };
}

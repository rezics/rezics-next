import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  addressLease,
  browserObservation,
  operationLease,
  ownedSessionCsrfToken,
  readLease,
  readerSessionSource,
  useReaderVisit,
} from '../../reader/lifetime/index';
import { getLocale } from '../../paraglide/runtime.js';
import { useSession } from '../../session/query';
import { viewerExposureQuery, type ViewerExposure } from '../../kernel/viewer-exposure';
import { draftFetch } from '../composer';
import { erasePost, revisePost, startThread, type ThreadCreated } from '../actions';
import { publishOwnDraft, readOwnDraftPost } from './actions';
import type {
  OwnDraftCommands,
  OwnDraftIdentity,
  OwnDraftLocalWritingReader,
  OwnDraftReader,
  OwnDraftReadback,
  OwnDraftWriteInput,
  OwnDraftEraseInput,
  OwnDraftStudioCreateInput,
  OwnDraftStudioRevisionInput,
} from './model';
import { ownDraftReaderForVisit } from './native-reader';
import type { EditFailure, RevisedPost, WriteFailure } from '../actions';

export type OwnDraftCommandTransport = Readonly<{
  create?: (
    input: OwnDraftStudioCreateInput,
    csrfToken: string,
    signal: AbortSignal,
  ) => Promise<{ ok: true; thread: ThreadCreated['thread'] } | WriteFailure>;
  revise?: (
    input: OwnDraftStudioRevisionInput,
    csrfToken: string,
    signal: AbortSignal,
  ) => Promise<{ ok: true; post: RevisedPost } | EditFailure>;
  write: (
    input: OwnDraftWriteInput,
    csrfToken: string,
    signal: AbortSignal,
  ) => Promise<{ ok: true; post: RevisedPost } | EditFailure>;
  erase: (input: OwnDraftEraseInput, csrfToken: string, signal: AbortSignal) => Promise<{ ok: true } | WriteFailure>;
  readback: (postId: string, signal: AbortSignal) => Promise<OwnDraftReadback>;
}>;

export const ownDraftNativeCommandTransport: OwnDraftCommandTransport = {
  create(input, csrfToken, signal) {
    return startThread({
      data: {
        boardId: input.boardId,
        title: input.title,
        body: input.body,
        licence: input.licence,
        subjectIds: [...input.subjectIds],
        mediaIds: [...input.mediaIds],
        visibility: 'draft',
        idempotencyKey: input.idempotencyKey,
      },
      headers: { 'X-CSRF-Token': csrfToken },
      signal,
      fetch: draftFetch(input.body),
    });
  },
  revise(input, csrfToken, signal) {
    return revisePost({
      data: {
        postId: input.postId,
        revisionId: input.revisionId,
        body: input.body,
        mediaIds: [...input.mediaIds],
        boardId: input.boardId,
        licence: input.licence,
        subjectIds: [...input.subjectIds],
        visibility: input.visibility,
        idempotencyKey: input.idempotencyKey,
      },
      headers: { 'X-CSRF-Token': csrfToken },
      signal,
      fetch: draftFetch(input.body),
    });
  },
  write(input, csrfToken, signal) {
    const data = {
      postId: input.postId,
      body: input.body,
      revisionId: input.revisionId,
      idempotencyKey: input.idempotencyKey,
      mediaIds: [...input.mediaIds],
    };
    if (input.action === 'publish')
      return publishOwnDraft({
        data,
        headers: { 'X-CSRF-Token': csrfToken },
        signal,
        fetch: draftFetch(input.body),
      });
    return revisePost({ data, headers: { 'X-CSRF-Token': csrfToken }, signal, fetch: draftFetch(input.body) });
  },
  erase(input, csrfToken, signal) {
    return erasePost({
      data: {
        postId: input.postId,
        idempotencyKey: input.idempotencyKey,
        ...(input.opening ? { openingThreadId: input.threadId } : {}),
      },
      headers: { 'X-CSRF-Token': csrfToken },
      signal,
    });
  },
  readback(postId, signal) {
    return readOwnDraftPost({ data: { postId }, signal });
  },
};

export type OwnDraftVisit = Readonly<{
  identity: OwnDraftIdentity;
  active: boolean;
  current: () => boolean;
  reader: OwnDraftReader;
  localWritingReader: OwnDraftLocalWritingReader;
  commands?: OwnDraftCommands;
}>;

type OwnDraftSource = Readonly<{
  client: ReturnType<typeof useQueryClient>;
  reader: OwnDraftReader;
  localWritingReader: OwnDraftLocalWritingReader;
  transport: OwnDraftCommandTransport;
  locale: ReturnType<typeof getLocale>;
}>;

type ExposureWitness = Readonly<{ query: object; data: unknown; dataUpdateCount: number }>;

let nextClientId = 0;
let nextVisitId = 0;
const clientIds = new WeakMap<object, number>();

function clientId(client: object): number {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = ++nextClientId;
    clientIds.set(client, id);
  }
  return id;
}

function retainedCommandCredentials(
  lease: ReturnType<typeof operationLease<string>>,
): (method: string, key: string) => string | null {
  let retained: { intent: string; credential: string } | null = null;
  return (method, key) => {
    if (!lease.current()) return null;
    const intentKey = JSON.stringify([method, key]);
    if (retained?.intent === intentKey) return retained.credential;
    const credential = lease.credential();
    if (!credential) return null;
    retained = { intent: intentKey, credential };
    return credential;
  };
}

function commandAdapters(
  current: () => boolean,
  csrfToken: string | null,
  transport: OwnDraftCommandTransport,
  scope: string,
  addressName: string,
): OwnDraftCommands | undefined {
  if (!csrfToken) return undefined;

  const credential = () => {
    if (!current()) return null;
    const owned = ownedSessionCsrfToken();
    return owned === csrfToken ? owned : null;
  };
  const read = readLease(`${scope}-${addressName}-command-readback`, addressLease(current), current);
  const createLease = operationLease(read, `${scope}-create`, current, credential);
  const revisionLease = operationLease(read, `${scope}-revision`, current, credential);
  const writeLease = operationLease(read, `${scope}-write`, current, credential);
  const eraseLease = operationLease(read, `${scope}-erase`, current, credential);
  const createCredential = retainedCommandCredentials(createLease);
  const revisionCredential = retainedCommandCredentials(revisionLease);
  const writeCredential = retainedCommandCredentials(writeLease);
  const eraseCredential = retainedCommandCredentials(eraseLease);

  return {
    async create(input, signal) {
      if (!transport.create) return { ok: false, reason: 'unavailable' };
      const token = createCredential('create', input.idempotencyKey);
      if (!token || signal.aborted) return { ok: false, reason: 'unavailable' };
      const result = await transport.create(input, token, signal);
      return signal.aborted || !createLease.current() ? { ok: false, reason: 'unavailable' } : result;
    },
    async revise(input, signal) {
      if (!transport.revise) return { ok: false, reason: 'unavailable' };
      const token = revisionCredential(input.visibility, input.idempotencyKey);
      if (!token || signal.aborted) return { ok: false, reason: 'unavailable' };
      const result = await transport.revise(input, token, signal);
      return signal.aborted || !revisionLease.current() ? { ok: false, reason: 'unavailable' } : result;
    },
    async write(input, signal) {
      const token = writeCredential(input.action, input.idempotencyKey);
      if (!token || signal.aborted) return { ok: false, reason: 'unavailable' };
      const result = await transport.write(input, token, signal);
      return signal.aborted || !writeLease.current() ? { ok: false, reason: 'unavailable' } : result;
    },
    async erase(input, signal) {
      const token = eraseCredential('erase', input.idempotencyKey);
      if (!token || signal.aborted) return { ok: false, reason: 'unavailable' };
      const result = await transport.erase(input, token, signal);
      return signal.aborted || !eraseLease.current() ? { ok: false, reason: 'unavailable' } : result;
    },
    async readback(postId, signal) {
      if (!read.current() || signal.aborted) return 'unavailable';
      const result = await transport.readback(postId, signal);
      return signal.aborted || !read.current() ? 'unavailable' : result;
    },
  };
}

/** Compose one irreversible own-drafts visit from the installed session and reader lifetime. */
export function useOwnDraftVisit(
  reader: OwnDraftReader,
  localWritingReader: OwnDraftLocalWritingReader,
  transport: OwnDraftCommandTransport,
  options: Readonly<{ scope?: string; source?: string; address?: string }> = {},
): OwnDraftVisit {
  // Keep the browser session owner mounted so its installed credential accessor has this QueryClient.
  const session = useSession();
  const client = useQueryClient();
  const locale = getLocale();
  const scope = options.scope ?? 'own-drafts';
  const sourceName = options.source ?? 'content';
  const addressName = options.address ?? '/drafts';
  const navigationVisit = useReaderVisit(scope, locale, getLocale);
  const observation = useMemo(() => browserObservation(client), [client]);
  const sessionSource = useMemo(() => readerSessionSource(client), [client]);
  const observed = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getServerSnapshot);
  const sessionRevision = useSyncExternalStore(
    sessionSource.subscribe,
    sessionSource.snapshot,
    sessionSource.serverSnapshot,
  );
  const sessionValue = sessionSource.read();
  const accountId =
    session.state === 'signed-in' &&
    sessionValue?.state === 'signed-in' &&
    observed.state === 'signed-in' &&
    session.subject === sessionValue.subject &&
    observed.observation.subject === sessionValue.subject
      ? sessionValue.subject
      : '';
  const csrfToken = accountId && sessionValue?.state === 'signed-in' ? sessionValue.csrfToken : null;
  const ready = !!accountId && sessionValue?.state === 'signed-in';
  const latest = useRef<OwnDraftSource>({ client, reader, localWritingReader, transport, locale });
  latest.current = { client, reader, localWritingReader, transport, locale };

  const visit = useMemo(() => {
    const capturedReader = reader;
    const capturedLocalWritingReader = localWritingReader;
    const capturedTransport = transport;
    const capturedLocale = locale;
    const capturedObservation = observed;
    const capturedSessionRevision = sessionRevision;
    const capturedAccountId = accountId;
    const capturedCsrfToken = csrfToken;
    const capturedNavigation = navigationVisit;
    const callerEpoch = `${clientId(client)}:${observed.state === 'signed-in' ? observed.observation.id : 0}:${++nextVisitId}`;
    const identity: OwnDraftIdentity = {
      accountId: capturedAccountId,
      authnEpoch: null,
      callerEpoch,
      locale: capturedLocale,
      source: sourceName,
      address: addressName,
    };
    const exposureKey =
      observed.state === 'signed-in'
        ? viewerExposureQuery(observed.observation).queryKey
        : (['exposure', 'viewer', 'closed'] as const);
    let exposureWitness: ExposureWitness | undefined;
    let retired = false;
    let revision = 0;
    const listeners = new Set<() => void>();
    let address: ReturnType<typeof addressLease>;

    const publish = () => {
      revision++;
      for (const listener of [...listeners]) listener();
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      address?.retire();
      publish();
    };
    const inspectExposure = () => {
      if (exposureKey[2] === 'closed') return;
      const query = client.getQueryCache().find({ queryKey: exposureKey, exact: true });
      if (
        !query ||
        query.state.status !== 'success' ||
        query.state.fetchStatus !== 'idle' ||
        query.state.isInvalidated
      ) {
        if (exposureWitness) retire();
        return;
      }
      const data = query.state.data as ViewerExposure | undefined;
      if (!data || data.subject !== capturedAccountId || data.state === 'denied' || data.state === 'unavailable') {
        if (exposureWitness) retire();
        return;
      }
      if (!exposureWitness) {
        exposureWitness = { query, data, dataUpdateCount: query.state.dataUpdateCount };
      } else if (
        exposureWitness.query !== query ||
        exposureWitness.data !== data ||
        exposureWitness.dataUpdateCount !== query.state.dataUpdateCount
      ) {
        retire();
      }
    };
    const parentCurrent = () => {
      const desired = latest.current;
      const actualSession = sessionSource.read();
      const browserCurrent = observation.getSnapshot();
      const isCurrent =
        !retired &&
        desired.client === client &&
        desired.reader === capturedReader &&
        desired.localWritingReader === capturedLocalWritingReader &&
        desired.transport === capturedTransport &&
        desired.locale === capturedLocale &&
        capturedNavigation.current() &&
        browserCurrent === capturedObservation &&
        sessionSource.snapshot() === capturedSessionRevision &&
        actualSession?.state === 'signed-in' &&
        actualSession.subject === capturedAccountId &&
        actualSession.csrfToken === capturedCsrfToken &&
        capturedObservation.state === 'signed-in' &&
        capturedObservation.observation.subject === capturedAccountId;
      if (!isCurrent) return false;
      inspectExposure();
      return !retired;
    };
    address = addressLease(parentCurrent);
    const read = readLease(
      JSON.stringify([
        callerEpoch,
        capturedAccountId,
        capturedObservation.state === 'signed-in' ? capturedObservation.observation.id : 0,
      ]),
      address,
      () => ready && parentCurrent(),
    );
    const current = () => {
      const value = !retired && read.current();
      if (!value) retire();
      return value && !retired;
    };
    const boundReader = ownDraftReaderForVisit(reader, identity, current);
    const commands = commandAdapters(current, capturedCsrfToken, transport, scope, addressName);

    return {
      identity,
      current,
      reader: boundReader,
      localWritingReader,
      ...(commands ? { commands } : {}),
      active: ready && current(),
      snapshot: () => revision,
      serverSnapshot: () => 0,
      subscribe(listener: () => void) {
        listeners.add(listener);
        const stopRetirement = observation.subscribeRetirement(retire);
        const stopExposure = observation.subscribeCache((event) => {
          if (JSON.stringify(event.query.queryKey) === JSON.stringify(exposureKey)) inspectExposure();
        });
        parentCurrent();
        return () => {
          listeners.delete(listener);
          stopRetirement();
          stopExposure();
          if (listeners.size === 0) retire();
        };
      },
    };
  }, [
    accountId,
    client,
    csrfToken,
    localWritingReader,
    navigationVisit,
    observation,
    observed,
    reader,
    ready,
    sessionRevision,
    sessionSource,
    transport,
    locale,
    scope,
    sourceName,
    addressName,
  ]);
  useSyncExternalStore(visit.subscribe, visit.snapshot, visit.serverSnapshot);
  return { ...visit, active: ready && visit.current() };
}

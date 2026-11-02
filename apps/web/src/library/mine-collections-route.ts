import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { loadMineCollectionsPage, type MineCollectionsPage } from './mine-collections';
import { admitMineCollectionsAddress, type MineCollectionsAddressError } from './mine-collections-address';
import { preparedPinsOrigin, readPreparedLibraryPins, type LibraryPinsRead } from './pins-read';

export type MineCollectionsAddress = {
  cursor: string | null;
  layout: 'rows' | 'previews';
  addressError?: MineCollectionsAddressError;
};
export type MineCollectionsViewerPage = {
  sessionSubject: string | null;
  requested: MineCollectionsAddress;
  page: MineCollectionsPage;
  pins: LibraryPinsRead;
};

export const readMineCollectionsPage = createServerFn({ method: 'GET' })
  .validator(admitMineCollectionsAddress)
  .handler(async ({ data }): Promise<MineCollectionsPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadMineCollectionsPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** The provenance and both private payloads come from one actual prepared request. */
export const readMineCollectionsViewerPage = createServerFn({ method: 'GET' })
  .validator(admitMineCollectionsAddress)
  .handler(async ({ data }): Promise<MineCollectionsViewerPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const requested: MineCollectionsAddress = {
      cursor: data.cursor ?? null,
      layout: data.layout,
      ...(data.addressError ? { addressError: data.addressError } : {}),
    };
    const closed: MineCollectionsViewerPage = {
      sessionSubject: null,
      requested,
      page: { signedIn: false, collections: [], next: null },
      pins: { state: 'closed', origin: { sessionSubject: null, credentialAgrees: false, requestedLimit: 100 } },
    };
    const request = getRequest();
    if (await prepareSession(request, env as Partial<SessionEnv>)) return closed;
    const subject = sessionSubject(request);
    const authorization = viewerCredential(request);
    if (!subject || !authorization || !preparedPinsOrigin(request, 100).credentialAgrees) return closed;
    if (data.addressError)
      return {
        ...closed,
        sessionSubject: subject,
        page: { signedIn: true, state: 'unavailable', invalidAddress: data.addressError, collections: [], next: null },
      };
    const client = kernelClient();
    const [page, pins] = await Promise.all([
      // This GET is already prepared. An unconfigured environment keeps the reader on the
      // same Request's captured credentials instead of authenticating a second session.
      loadMineCollectionsPage(client, request, {}, data),
      readPreparedLibraryPins(client, request, 100),
    ]);
    if (sessionSubject(request) !== subject || viewerCredential(request) !== authorization) return closed;
    return { sessionSubject: subject, requested, page, pins };
  });

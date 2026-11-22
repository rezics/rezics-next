import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { kernelHeaders, writeSession } from './collection-records';

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;
function id(value: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid Collection application ID');
  return value;
}

function privateResponse() {
  setResponseHeader('cache-control', 'private, no-store');
  return getRequest();
}

export type SubjectApplicationTarget =
  | { scope: 'collection'; collectionId: string; memberId: string }
  | { scope: 'personal'; subjectId: string };

function applicationTarget(data: SubjectApplicationTarget): SubjectApplicationTarget {
  if (data.scope === 'collection')
    return { scope: 'collection', collectionId: id(data.collectionId), memberId: id(data.memberId) };
  if (data.scope === 'personal') return { scope: 'personal', subjectId: id(data.subjectId) };
  throw new Error('Invalid Subject application scope');
}

export const readSubjectApplications = createServerFn({ method: 'GET' })
  .validator(applicationTarget)
  .handler(async ({ data }) => {
    const request = privateResponse();
    if (await prepareSession(request, env as Partial<SessionEnv>)) return null;
    const authorization = viewerCredential(request);
    if (!authorization) return null;
    const client = kernelClient();
    const result =
      data.scope === 'personal'
        ? await client.libraryEntries({ subjectId: data.subjectId }).applications.get({ headers: { authorization } })
        : await client
            .collections({ collectionId: data.collectionId })
            .members({ memberId: data.memberId })
            .applications.get({ headers: { authorization } });
    return result.data?.appliedSubjectIds ?? null;
  });

export const updateSubjectApplication = createServerFn({ method: 'POST' })
  .validator((data: { target: SubjectApplicationTarget; appliedSubjectId: string; present: boolean; key: string }) => {
    if (typeof data.present !== 'boolean') throw new Error('Invalid Subject application intent');
    return {
      target: applicationTarget(data.target),
      appliedSubjectId: id(data.appliedSubjectId),
      present: data.present,
      key: id(data.key),
    };
  })
  .handler(async ({ data }) => {
    const request = privateResponse();
    const session = await writeSession(request, env as Partial<SessionEnv>);
    if (!('authorization' in session)) return { state: 'refused' as const };
    const { target, appliedSubjectId, present, key } = data;
    const options = { headers: kernelHeaders(session.authorization, JSON.stringify(key)) };
    const client = kernelClient();
    const response =
      target.scope === 'personal'
        ? await client
            .libraryEntries({ subjectId: target.subjectId })
            .applications({ appliedSubjectId })
            .put({ present }, options)
        : await (async () => {
            const endpoint = client
              .collections({ collectionId: target.collectionId })
              .members({ memberId: target.memberId })
              .applications({ appliedSubjectId });
            return present ? endpoint.put(undefined, options) : endpoint.delete(undefined, options);
          })();
    if (response.data?.appliedSubjectId === appliedSubjectId && response.data.present === present)
      return { state: 'saved' as const };
    return { state: response.status >= 500 ? ('uncertain' as const) : ('refused' as const) };
  });

export const readCollectionAppliedMembers = createServerFn({ method: 'GET' })
  .validator((data: { collectionId: string; appliedSubjectId: string; cursor?: string }) => {
    if (data.cursor !== undefined && (typeof data.cursor !== 'string' || data.cursor.length > 4096))
      throw new Error('Invalid Collection application cursor');
    return { collectionId: id(data.collectionId), appliedSubjectId: id(data.appliedSubjectId), cursor: data.cursor };
  })
  .handler(async ({ data }) => {
    const request = privateResponse();
    if (await prepareSession(request, env as Partial<SessionEnv>)) return null;
    const authorization = viewerCredential(request);
    const { collectionId, appliedSubjectId, cursor } = data;
    const result = await kernelClient()
      .collections({ collectionId })
      .applications({ appliedSubjectId })
      .members.get({
        query: { limit: 20, ...(cursor ? { cursor } : {}) },
        headers: authorization ? { authorization } : {},
      });
    return result.data ?? null;
  });

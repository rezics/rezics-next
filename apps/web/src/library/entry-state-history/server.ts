import * as v from 'valibot';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareExpectedReader } from '../../session/expected-reader';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import { captureAnnotationCredential, originalAnnotationCredential } from '../rich-private-entry/credential';
import {
  listEntryStateHistory,
  readCurrentEntry,
  restoreEntryState,
  reviewEntryStateChange,
  type RestoreCommand,
} from './native';

const subjectId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const reader = v.object({
  expectedReader: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  expectedCredential: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
const revision = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_147_483_646));
const pageInput = v.object({
  ...reader.entries,
  subjectId,
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)), 20),
});
const addressedInput = v.object({ ...reader.entries, subjectId, changeRevision: revision });
const restoreInput = v.object({
  ...reader.entries,
  subjectId,
  changeRevision: revision,
  incarnationId: v.pipe(v.string(), v.uuid()),
  currentRevision: revision,
  key: v.pipe(v.string(), v.uuid()),
  credential: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,6400}$/)),
});
const readbackInput = v.object({ ...reader.entries, subjectId });

function privateResponse() {
  setResponseHeader('cache-control', 'private, no-store');
}

export const readEntryHistoryPage = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(pageInput, value))
  .handler(async ({ data }) => {
    privateResponse();
    const authorization = await prepareExpectedReader(getRequest(), env as Partial<SessionEnv>, data);
    const result = authorization
      ? await listEntryStateHistory(kernelClient(), authorization, data.subjectId, data.cursor, data.limit)
      : { kind: 'retired' as const };
    return { viewer: data.expectedReader, subjectId: data.subjectId, result };
  });

export const readEntryHistoryReview = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(addressedInput, value))
  .handler(async ({ data }) => {
    privateResponse();
    const request = getRequest();
    const authorization = await prepareExpectedReader(request, env as Partial<SessionEnv>, data);
    if (!authorization) return { viewer: data.expectedReader, subjectId: data.subjectId, result: { kind: 'retired' as const }, credential: null };
    const result = await reviewEntryStateChange(kernelClient(), authorization, data.subjectId, data.changeRevision);
    if (result.kind !== 'ready') return { viewer: data.expectedReader, subjectId: data.subjectId, result, credential: null };
    try {
      const credential = await captureAnnotationCredential(
        request,
        env as Partial<SessionEnv>,
        { viewer: data.expectedReader, csrfToken: data.expectedCredential, authorization },
        data.subjectId,
      );
      return { viewer: data.expectedReader, subjectId: data.subjectId, result, credential };
    } catch {
      return { viewer: data.expectedReader, subjectId: data.subjectId, result: { kind: 'unavailable' as const }, credential: null };
    }
  });

export const sendEntryStateRestore = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(restoreInput, value))
  .handler(async ({ data }) => {
    privateResponse();
    const request = getRequest();
    const session = await readSubjectSlotSession(request, env as Partial<SessionEnv>);
    if (session.state !== 'signed-in' || !session.csrfToken || session.subject !== data.expectedReader)
      return { viewer: data.expectedReader, subjectId: data.subjectId, result: { kind: 'retired' as const } };
    const authorization = await originalAnnotationCredential(
      request,
      env as Partial<SessionEnv>,
      { viewer: session.subject, csrfToken: session.csrfToken, authorization: session.authorization },
      {
        viewer: data.expectedReader,
        csrfToken: data.expectedCredential,
        subjectId: data.subjectId,
        credential: data.credential,
      },
    );
    if (!authorization)
      return { viewer: data.expectedReader, subjectId: data.subjectId, result: { kind: 'retired' as const } };
    const command: RestoreCommand = {
      subjectId: data.subjectId,
      changeRevision: data.changeRevision,
      incarnationId: data.incarnationId,
      currentRevision: data.currentRevision,
      key: data.key,
    };
    const result = await restoreEntryState(kernelClient(), authorization, command);
    return { viewer: data.expectedReader, subjectId: data.subjectId, result };
  });

export const readEntryAfterRestore = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(readbackInput, value))
  .handler(async ({ data }) => {
    privateResponse();
    const authorization = await prepareExpectedReader(getRequest(), env as Partial<SessionEnv>, data);
    const result = authorization
      ? await readCurrentEntry(kernelClient(), authorization, data.subjectId)
      : { kind: 'retired' as const };
    return { viewer: data.expectedReader, subjectId: data.subjectId, result };
  });

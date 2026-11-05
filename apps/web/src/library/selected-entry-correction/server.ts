import * as v from 'valibot';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSubjectSlotSession } from '../subject-slot';
import { captureAnnotationCredential, originalAnnotationCredential } from '../rich-private-entry/credential';
import { sendCorrection, readCorrection, type CommandResult } from './native';

const binding = 'selected-entry-correction';
const uuid = v.pipe(v.string(), v.uuid());
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(192));
const integer = (min: number, max: number) => v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));
const field = <T extends v.GenericSchema>(value: T) =>
  v.variant('op', [
    v.object({ op: v.literal('preserve') }),
    v.object({ op: v.literal('clear') }),
    v.object({ op: v.literal('set'), value }),
  ]);
const note = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((value) => new TextEncoder().encode(value).byteLength <= 4096),
);
const selection = v.object({
  subjectId: text,
  incarnationId: uuid,
  currentRevision: integer(1, Number.MAX_SAFE_INTEGER),
  note: field(note),
  priority: field(integer(1, 100)),
});
const command = v.variant('kind', [
  v.object({
    kind: v.literal('create'),
    items: v.pipe(v.array(selection), v.minLength(1), v.maxLength(16)),
    key: uuid,
  }),
  v.object({
    kind: v.literal('confirm'),
    reviewId: text,
    key: uuid,
    body: v.object({ epoch: uuid, position: integer(0, 15) }),
  }),
  v.object({ kind: v.literal('cancel'), reviewId: text, key: uuid, body: v.object({ epoch: uuid }) }),
]);
export type CorrectionIdentity = { viewer: string; csrfToken: string; credential: string };
const identitySchema = v.object({
  viewer: text,
  csrfToken: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  credential: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,6400}$/)),
});
async function currentIdentity() {
  setResponseHeader('cache-control', 'private, no-store');
  const session = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
  return session.state === 'signed-in' && session.csrfToken
    ? { viewer: session.subject, csrfToken: session.csrfToken, authorization: session.authorization }
    : null;
}
export const captureCorrectionSender = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CorrectionIdentity | null> => {
    const identity = await currentIdentity();
    if (!identity) return null;
    return {
      viewer: identity.viewer,
      csrfToken: identity.csrfToken,
      credential: await captureAnnotationCredential(getRequest(), env as Partial<SessionEnv>, identity, binding),
    };
  },
);
export const sendSelectedCorrection = createServerFn({ method: 'POST' })
  .validator((value: unknown) => v.parse(v.object({ identity: identitySchema, command }), value))
  .handler(async ({ data }): Promise<CommandResult> => {
    const identity = await currentIdentity();
    if (!identity) return { kind: 'rejected', status: 401 };
    const authorization = await originalAnnotationCredential(getRequest(), env as Partial<SessionEnv>, identity, {
      ...data.identity,
      subjectId: binding,
    });
    if (!authorization) return { kind: 'rejected', status: 401 };
    return sendCorrection(kernelClient(), authorization, data.command);
  });
export const readSelectedCorrection = createServerFn({ method: 'GET' })
  .validator((value: unknown) => v.parse(v.object({ viewer: text, reviewId: text, page: integer(0, 3) }), value))
  .handler(async ({ data }) => {
    const identity = await currentIdentity();
    if (!identity || identity.viewer !== data.viewer) return { kind: 'rejected' as const, status: 401 };
    return readCorrection(kernelClient(), identity.authorization, data.reviewId, data.page);
  });

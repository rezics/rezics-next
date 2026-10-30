import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { editionContentId, type EditionCreateApi } from './edition-create';
import { createNativeEditionCreateApi, unavailableEditionCreateApi } from './edition-create-native';

const id = v.pipe(v.string(), v.regex(editionContentId));
const identity = v.strictObject({ postId: id, revisionId: id });
const key = v.pipe(v.string(), v.uuid());
const createIntent = v.strictObject({ kind: v.literal('create'), source: identity, targetSubjectId: id, key });
const publishIntent = v.strictObject({
  kind: v.literal('publish'),
  source: v.nullable(identity),
  targetSubjectId: id,
  editionId: id,
  editionRevision: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,18}$/)),
  key,
});

async function api(): Promise<EditionCreateApi> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  // The ordinary session path also checks Origin and the current CSRF token for server-function POSTs.
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  const viewerId = sessionSubject(request);
  if (!authorization || !viewerId) {
    const refused = { kind: 'refused', status: 401 } as const;
    return {
      source: async () => refused,
      resume: async () => refused,
      command: async () => refused,
      review: async () => refused,
    };
  }
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  return origin ? createNativeEditionCreateApi(origin, authorization, viewerId) : unavailableEditionCreateApi;
}

export const readEditionCreateSource = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(identity, input))
  .handler(async ({ data }) => (await api()).source(data));

export const readEditionResume = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(v.strictObject({ editionId: id }), input))
  .handler(async ({ data }) => (await api()).resume(data.editionId));

export const readEditionCreateEntry = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(identity, input))
  .handler(async ({ data }) => {
    const result = await (await api()).source(data, false);
    return result.kind === 'source' ? { kind: 'available' as const } : result;
  });

export const commandEditionPublication = createServerFn({ method: 'POST' })
  .validator((input: unknown) => v.parse(v.variant('kind', [createIntent, publishIntent]), input))
  .handler(async ({ data }) => (await api()).command(data));

export const reviewEditionPublication = createServerFn({ method: 'GET' })
  .validator((input: unknown) =>
    v.parse(v.strictObject({ source: v.nullable(identity), editionId: v.nullable(id) }), input),
  )
  .handler(async ({ data }) => (await api()).review(data.source, data.editionId));

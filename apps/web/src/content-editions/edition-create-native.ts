import { createKernelClient, type KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { parseEditionMetadata, type EditionMetadata } from './edition-api';
import { editionDocumentDigest } from './edition-model';
import {
  editionContentId,
  editionMatchesSource,
  type EditionCreateApi,
  type EditionCreateFailure,
  type EditionCreateSource,
  type EditionPublicationIntent,
  type EditionSourceIdentity,
  type EditionSourceRead,
} from './edition-create';

const commandSchema = v.strictObject({
  editionId: v.pipe(v.string(), v.regex(editionContentId)),
  editionRevision: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,18}$/)),
});
export function parseEditionCommand(value: unknown) {
  const parsed = v.safeParse(commandSchema, value);
  return parsed.success ? parsed.output : null;
}
const pending: EditionCreateFailure = { kind: 'unavailable', status: 503, reason: 'native-pending' };
export const unavailableEditionCreateApi: EditionCreateApi = {
  source: async () => pending,
  command: async () => pending,
  review: async () => pending,
};

function failure(status: number, command = false): EditionCreateFailure {
  if (status === 409 || status === 412 || status === 422) return { kind: 'conflict', status };
  if (status === 401 || status === 403 || status === 404 || status === 410)
    return { kind: 'refused', status, reason: 'source' };
  return { kind: command && status >= 500 ? 'uncertain' : 'unavailable', status, reason: 'dependency' };
}

/** Exact existing source reads and current native admission, with no inferred owner permission. */
export async function readEditionCreateSource(
  client: KernelClient,
  authorization: string,
  viewerId: string,
  identity: EditionSourceIdentity,
): Promise<EditionSourceRead> {
  const auth = { headers: { authorization }, fetch: { redirect: 'manual' as const } };
  try {
    const exact = await client.posts({ id: identity.postId }).revisions({ revisionId: identity.revisionId }).get(auth);
    if (exact.error || !exact.data) return failure(exact.status);
    const revision = exact.data.post;
    if (
      revision.availability !== 'available' ||
      revision.id !== identity.postId ||
      revision.revisionId !== identity.revisionId ||
      revision.authorId !== viewerId ||
      !['published', 'protected'].includes(revision.visibility) ||
      revision.subjectIds.length === 0 ||
      revision.subjectIds.length > 128 ||
      (await editionDocumentDigest(revision.body)) !== revision.sha256
    )
      return { kind: 'refused', status: 404, reason: 'source' };
    const actions = await client.viewerActions.post(
      { resources: [{ type: 'content.post', id: identity.postId }] },
      auth,
    );
    if (actions.error || !actions.data) return failure(actions.status);
    const resource = actions.data.resources.find((item) => item.type === 'content.post' && item.id === identity.postId);
    // Content is not yet registered in the current native viewer-actions catalogue. This is no permission assertion.
    if (!resource || !('viewerActions' in resource))
      return { kind: 'unavailable', status: 503, reason: 'admission-pending' };
    if (
      !resource.viewerActions.some(
        (entry) =>
          entry.action === 'post:revise' &&
          entry.operations.some((operation) => operation === 'post.revise' || operation === 'content_edition.create'),
      )
    )
      return { kind: 'refused', status: 403 };
    // Exact GET owns the live Context/ancestor authority; never reconstruct it from a board or identity.
    const final = await client.posts({ id: identity.postId }).revisions({ revisionId: identity.revisionId }).get(auth);
    if (final.error || !final.data) return failure(final.status);
    const current = final.data.post;
    if (
      current.availability !== 'available' ||
      current.id !== revision.id ||
      current.revisionId !== revision.revisionId ||
      current.authorId !== revision.authorId ||
      current.sha256 !== revision.sha256 ||
      current.licence !== revision.licence ||
      current.boardId !== revision.boardId ||
      current.threadId !== revision.threadId ||
      current.visibility !== revision.visibility ||
      JSON.stringify(current.subjectIds) !== JSON.stringify(revision.subjectIds)
    )
      return { kind: 'conflict', status: 412 };
    return {
      kind: 'source',
      source: {
        ...identity,
        creatorAccountId: revision.authorId,
        body: current.body,
        sha256: revision.sha256,
        licence: revision.licence,
        subjectIds: [...revision.subjectIds],
      },
    };
  } catch {
    return { kind: 'unavailable', status: 503, reason: 'dependency' };
  }
}

/** Isolated wire binding to the producer's actual edition-routes.ts and closed schemas.
 * Generated clients in this checkout do not yet expose these operations. No development fake is used.
 */
export function createNativeEditionCreateApi(
  origin: string,
  authorization: string,
  viewerId: string,
  fetcher: typeof fetch = globalThis.fetch,
): EditionCreateApi {
  let session: string | null = null;
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (session) headers.set('rezics-session-token', session);
      const response = await fetcher(input, { ...init, headers, redirect: 'manual', cache: 'no-store' });
      const next = response.headers.get('rezics-session-token');
      if (next) session = next;
      return response;
    },
    { preconnect: (...args: Parameters<typeof fetch.preconnect>) => fetcher.preconnect?.(...args) },
  );
  const client = createKernelClient(origin, { fetch: transport });
  const source = (identity: EditionSourceIdentity) =>
    readEditionCreateSource(client, authorization, viewerId, identity);
  async function metadata(id: string): Promise<EditionMetadata | EditionCreateFailure> {
    const response = await transport(new URL(`/v1/contentEditions/${encodeURIComponent(id)}`, origin), {
      headers: { authorization },
    });
    if (response.status !== 200) return failure(response.status);
    const value = parseEditionMetadata(await response.json());
    return value && value.editionId === id && /^[1-9][0-9]{0,18}$/.test(value.editionRevision)
      ? value
      : { kind: 'unavailable', status: 502, reason: 'binding' };
  }
  async function publishAdmission(editionId: string): Promise<EditionCreateFailure | null> {
    const result = await client.viewerActions.post(
      { resources: [{ type: 'content.edition', id: editionId }] },
      {
        headers: { authorization },
      },
    );
    if (result.error || !result.data) return failure(result.status);
    const resource = result.data.resources.find((item) => item.type === 'content.edition' && item.id === editionId);
    if (!resource || !('viewerActions' in resource))
      return { kind: 'unavailable', status: 503, reason: 'admission-pending' };
    return resource.viewerActions.some(
      (entry) => entry.action === 'edition:sell' && entry.operations.includes('content_edition.publish'),
    )
      ? null
      : { kind: 'refused', status: 403 };
  }
  async function currentSource(intent: EditionPublicationIntent): Promise<EditionCreateSource | EditionCreateFailure> {
    const selected = await source(intent.source);
    if (selected.kind !== 'source') return selected;
    if (!selected.source.subjectIds.includes(intent.targetSubjectId))
      return { kind: 'refused', status: 404, reason: 'source' };
    // One chosen original subject point, no per-candidate reads or redirect substitution.
    const subject = await client.subjects({ id: intent.targetSubjectId }).get({
      headers: { authorization },
      fetch: { redirect: 'manual' },
    });
    if (subject.error || subject.status !== 200 || subject.data?.subject.id !== intent.targetSubjectId)
      return subject.status >= 400 ? failure(subject.status) : { kind: 'refused', status: 404, reason: 'source' };
    return selected.source;
  }
  return {
    source,
    async command(intent) {
      let sent = false;
      try {
        const selected = await currentSource(intent);
        if ('kind' in selected) return selected;
        if (intent.kind === 'publish') {
          const denied = await publishAdmission(intent.editionId);
          if (denied) return denied;
        }
        const path =
          intent.kind === 'create'
            ? '/v1/contentEditions'
            : `/v1/contentEditions/${encodeURIComponent(intent.editionId)}:publish`;
        const body =
          intent.kind === 'create'
            ? {
                postId: intent.source.postId,
                revisionId: intent.source.revisionId,
                targetSubjectId: intent.targetSubjectId,
              }
            : {};
        sent = true;
        const response = await transport(new URL(path, origin), {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(intent.key),
            ...(intent.kind === 'publish' ? { 'if-match': `"${intent.editionRevision}"` } : {}),
          },
          body: JSON.stringify(body),
        });
        if (response.status !== (intent.kind === 'create' ? 201 : 200)) return failure(response.status, true);
        // The actual route returns the flat ContentEditionCommandSchema, not a guessed { edition } wrapper.
        const command = parseEditionCommand(await response.json());
        if (!command || (intent.kind === 'publish' && command.editionId !== intent.editionId))
          return { kind: 'uncertain', status: 502, reason: 'binding' };
        const current = await metadata(command.editionId);
        if ('kind' in current)
          return {
            ...current,
            kind: 'uncertain',
            editionId: command.editionId,
            concealSource: current.kind === 'refused',
          };
        if (!editionMatchesSource(current, selected, intent.targetSubjectId))
          return { kind: 'uncertain', status: 502, reason: 'binding', editionId: command.editionId };
        if (
          current.editionRevision !== command.editionRevision ||
          current.state !== (intent.kind === 'create' ? 'draft' : 'published')
        )
          return { kind: 'conflict', status: 412, editionId: command.editionId };
        return { kind: 'confirmed', edition: current };
      } catch {
        return { kind: sent ? 'uncertain' : 'unavailable', status: 503, reason: 'dependency' };
      }
    },
    async review(identity, editionId) {
      try {
        const selected = await source(identity);
        if (selected.kind !== 'source') return selected;
        const edition = editionId ? await metadata(editionId) : null;
        if (edition && 'kind' in edition) return edition;
        return { kind: 'review', source: selected.source, edition };
      } catch {
        return { kind: 'unavailable', status: 503, reason: 'dependency' };
      }
    },
  };
}

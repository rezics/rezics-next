import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import {
  knowledgeMediaQuery,
  parseKnowledgeMediaSelection,
  parseKnowledgeMediaSource,
  type KnowledgeMediaSelection,
} from '@rezics/definitions/knowledge-media';
import { hasKernelOrigin, kernelClient } from '../kernel/client';
import { recordPageReadCacheControl } from '../security/page-cache';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import type { SessionEnv } from '../session/client';
import { loadKnowledgeDocumentMedia, type DocumentImagePresentation } from '../threads/document-media';
import { KNOWLEDGE_IMAGE_LIMIT, knowledgeImageSelection } from './media';

export type KnowledgeMediaRequest = {
  sources: readonly string[];
  own: KnowledgeMediaSelection | null;
  viewer: string | null;
  locale: string;
};
export type KnowledgeMediaResult =
  | { state: 'ready'; images: readonly { source: string; presentation: DocumentImagePresentation }[] }
  | { state: 'unavailable' };

function request(value: unknown): KnowledgeMediaRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid Knowledge image request');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['sources', 'own', 'viewer', 'locale'].includes(key)) ||
    !Array.isArray(input.sources) ||
    input.sources.length > KNOWLEDGE_IMAGE_LIMIT ||
    input.sources.some((source) => !parseKnowledgeMediaSource(source)) ||
    new Set(input.sources).size !== input.sources.length ||
    !(input.own === null || parseKnowledgeMediaSelection(input.own)?.representation === 'authoring') ||
    !(
      input.viewer === null ||
      (typeof input.viewer === 'string' && input.viewer.length > 0 && input.viewer.length <= 256)
    ) ||
    typeof input.locale !== 'string' ||
    !input.locale ||
    input.locale.length > 64
  )
    throw new TypeError('Invalid Knowledge image request');
  return input as KnowledgeMediaRequest;
}

/** Group by exact original authority. No image/body fetch or per-node metadata request is introduced. */
export async function readKnowledgeMediaGroups(
  input: KnowledgeMediaRequest,
  read: (ids: readonly string[], selection: KnowledgeMediaSelection) => ReturnType<typeof loadKnowledgeDocumentMedia>,
): Promise<KnowledgeMediaResult> {
  const groups = new Map<string, { selection: KnowledgeMediaSelection; sources: Map<string, string[]> }>();
  for (const source of input.sources) {
    const parsed = parseKnowledgeMediaSource(source),
      selection = knowledgeImageSelection(source, input.own);
    if (!parsed || !selection) continue;
    const key = JSON.stringify(knowledgeMediaQuery(selection));
    let group = groups.get(key);
    if (!group) {
      group = { selection, sources: new Map() };
      groups.set(key, group);
    }
    const sources = group.sources.get(parsed.mediaId) ?? [];
    sources.push(source);
    group.sources.set(parsed.mediaId, sources);
  }
  const pending = [...groups.values()];
  let next = 0;
  const images: { source: string; presentation: DocumentImagePresentation }[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) {
        const group = pending[next++]!;
        try {
          const result = await read([...group.sources.keys()], group.selection);
          if (result.kind !== 'ready') continue;
          for (const [id, presentation] of result.images)
            for (const source of group.sources.get(id) ?? []) images.push({ source, presentation });
        } catch {
          /* Independent source failure withholds only that group's metadata. */
        }
      }
    }),
  );
  return { state: 'ready', images };
}

export const readKnowledgeMediaRequest = createServerFn({ method: 'GET' })
  .validator(request)
  .handler(async ({ data }): Promise<KnowledgeMediaResult> => {
    const incoming = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(incoming, 'private, no-store');
    if (!hasKernelOrigin()) return { state: 'unavailable' };
    const privateSources = data.sources.some(
      (source) => knowledgeImageSelection(source, data.own)?.representation === 'authoring',
    );
    let authorization: string | undefined;
    if (privateSources)
      try {
        await prepareSession(incoming, env as Partial<SessionEnv>);
        if (data.viewer && sessionSubject(incoming) === data.viewer)
          authorization = viewerCredential(incoming) ?? undefined;
      } catch {
        /* Public-context images remain independently readable anonymously. */
      }
    return readKnowledgeMediaGroups(data, (ids, selection) =>
      selection.representation === 'authoring' && !authorization
        ? Promise.resolve({ kind: 'unavailable' })
        : loadKnowledgeDocumentMedia(
            kernelClient(data.locale, selection.representation === 'authoring' ? authorization : undefined),
            ids,
            selection,
            selection.representation === 'authoring' ? authorization : undefined,
            incoming.signal,
          ),
    );
  });

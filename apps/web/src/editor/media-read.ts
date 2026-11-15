import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { DOCUMENT_MEDIA_LIMIT } from '../threads/document-media-limit';

/** Existing presentation read, using the current server-owned session credential. It grants no media access. */
export const readEditorImagePresentations = createServerFn({ method: 'GET' })
  .validator((input: unknown): { ids: string[]; subject: string | null } => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('ids' in input) ||
      !('subject' in input) ||
      Object.keys(input).some((key) => !['ids', 'subject'].includes(key)) ||
      !Array.isArray(input.ids) ||
      input.ids.length > DOCUMENT_MEDIA_LIMIT ||
      input.ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) ||
      new Set(input.ids).size !== input.ids.length ||
      (input.subject !== null && (typeof input.subject !== 'string' || input.subject.length > 256))
    )
      throw new Error('Invalid editor media references');
    return { ids: input.ids as string[], subject: input.subject };
  })
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { prepareSession, viewerCredential, sessionSubject } = await import('../session/request');
    const { kernelClient } = await import('../kernel/client');
    const { loadDocumentMedia } = await import('../threads/document-media');
    const request = getRequest();
    await prepareSession(request, env);
    if ((sessionSubject(request) ?? null) !== data.subject) return { kind: 'unavailable' as const, images: [] };
    const result = await loadDocumentMedia(kernelClient(), data.ids, viewerCredential(request) ?? null, request.signal);
    return result.kind === 'ready'
      ? { kind: 'ready' as const, images: [...result.images.values()] }
      : { kind: 'unavailable' as const, images: [] };
  });

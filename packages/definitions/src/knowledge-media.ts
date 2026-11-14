/** Native source coordinates, never a grant or an object-store URL. */
export type KnowledgeMediaSelection =
  | Readonly<{
      representation: 'authoring';
      documentId: string;
      revisionId: string;
      sourceSha256: string;
      publicationId?: never;
    }>
  | Readonly<{
      representation: 'public';
      documentId: string;
      revisionId: string;
      sourceSha256: string;
      publicationId: string;
    }>;

const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const fields = ['representation', 'documentId', 'revisionId', 'sourceSha256', 'publicationId'];

export function parseKnowledgeMediaSelection(value: unknown): KnowledgeMediaSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key)) ||
      typeof input.documentId !== 'string' || !id.test(input.documentId) ||
      typeof input.revisionId !== 'string' || !id.test(input.revisionId) ||
      typeof input.sourceSha256 !== 'string' || !digest.test(input.sourceSha256)) return null;
  if (input.representation === 'authoring') {
    if (input.publicationId !== undefined) return null;
  } else if (input.representation !== 'public' || typeof input.publicationId !== 'string' ||
             !id.test(input.publicationId)) return null;
  return input as KnowledgeMediaSelection;
}

/** A bare locator is an authored request to claim an owned image. A contextual
 * locator retains an independent exact source; copying it creates no new claim.
 */
export function knowledgeMediaSource(mediaId: string, selection?: KnowledgeMediaSelection): string {
  if (!id.test(mediaId)) throw new TypeError('Invalid managed media ID');
  const locator = new URL(`rezics-media:${mediaId}`);
  if (selection !== undefined) {
    if (!parseKnowledgeMediaSelection(selection)) throw new TypeError('Invalid Knowledge media selection');
    for (const key of fields) {
      const value = Reflect.get(selection, key);
      if (value !== undefined) locator.searchParams.set(key, value);
    }
  }
  return locator.href;
}

export function parseKnowledgeMediaSource(src: unknown): Readonly<{
  mediaId: string;
  selection: KnowledgeMediaSelection | null;
}> | null {
  if (typeof src !== 'string' || src.length > 2048 || !src.startsWith('rezics-media:')) return null;
  try {
    const locator = new URL(src);
    if (locator.protocol !== 'rezics-media:' || locator.host || locator.hash || !id.test(locator.pathname)) return null;
    if (!locator.search) return { mediaId: locator.pathname, selection: null };
    const input: Record<string, string> = {};
    for (const [key, value] of locator.searchParams) {
      if (!fields.includes(key) || Object.hasOwn(input, key)) return null;
      input[key] = value;
    }
    const selection = parseKnowledgeMediaSelection(input);
    return selection ? { mediaId: locator.pathname, selection } : null;
  } catch { return null; }
}

/** The ordinary media download route transports the same exact coordinates. */
export function knowledgeMediaQuery(selection: KnowledgeMediaSelection): Readonly<Record<string, string>> {
  if (!parseKnowledgeMediaSelection(selection)) throw new TypeError('Invalid Knowledge media selection');
  return {
    knowledgeRepresentation: selection.representation,
    knowledgeDocumentId: selection.documentId,
    knowledgeRevisionId: selection.revisionId,
    knowledgeSourceSha256: selection.sourceSha256,
    ...(selection.representation === 'public' ? { knowledgePublicationId: selection.publicationId } : {}),
  };
}

export function parseKnowledgeMediaQuery(query: Readonly<Record<string, unknown>>): KnowledgeMediaSelection | undefined {
  const names = {
    knowledgeRepresentation: 'representation', knowledgeDocumentId: 'documentId',
    knowledgeRevisionId: 'revisionId', knowledgeSourceSha256: 'sourceSha256',
    knowledgePublicationId: 'publicationId',
  } as const;
  const input: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(names)) if (query[key] !== undefined) input[target] = query[key];
  if (Object.keys(input).length === 0) return undefined;
  const selection = parseKnowledgeMediaSelection(input);
  if (!selection) throw new TypeError('Invalid Knowledge media source context');
  return selection;
}

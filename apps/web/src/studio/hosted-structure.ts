import * as v from 'valibot';
import { bookTocRows } from './book-toc';
import type { BookPlacement, BookStructure } from './contract';
import { hostedId, hostedPlacement, type HostedBook, type HostedPlacement } from './hosted-contract';

export function hostedRoute(id: string): string {
  v.parse(hostedId, id);
  return id.slice(24, 28);
}

/** Preserve occurrence identity and sibling position while adapting the native, body-free outline. */
export function hostedBookStructure(book: HostedBook): BookStructure {
  if (book.placements.length > 512) throw new Error('The hosted structure exceeds its placement limit');
  const route = hostedRoute(book.revision.catalogueId);
  if (
    hostedRoute(book.revision.revisionId) !== route ||
    (book.revision.sourceRevisionId !== null && hostedRoute(book.revision.sourceRevisionId) !== route)
  )
    throw new Error('Invalid hosted revision address');
  const children = new Map<string | null, HostedPlacement[]>();
  for (const raw of book.placements) {
    const placement = v.parse(hostedPlacement, raw);
    if (
      hostedRoute(placement.occurrenceId) !== route ||
      (placement.parentId !== null && hostedRoute(placement.parentId) !== route) ||
      !placement.title.trim()
    )
      throw new Error('Invalid hosted occurrence address');
    if (placement.kind === 'chapter') {
      const targetRoute = hostedRoute(placement.target.postId);
      if (
        hostedRoute(placement.target.threadId) !== targetRoute ||
        hostedRoute(placement.target.revisionId) !== targetRoute
      )
        throw new Error('Invalid hosted chapter address');
    }
    const siblings = children.get(placement.parentId) ?? [];
    siblings.push(placement);
    children.set(placement.parentId, siblings);
  }
  const placements: BookPlacement[] = [];
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.position - b.position);
    siblings.forEach((entry, index) => {
      if (entry.position !== index) throw new Error('Invalid hosted sibling order');
      placements.push({
        occurrenceId: entry.occurrenceId,
        parentOccurrenceId: entry.parentId,
        title: entry.title,
        target:
          entry.kind === 'part'
            ? { kind: 'part' }
            : {
                kind: 'chapter',
                document: {
                  postId: entry.target.postId,
                  revisionId: entry.target.revisionId,
                  sha256: entry.target.sha256,
                },
              },
      });
    });
  }
  const structure: BookStructure = {
    catalogueId: book.revision.catalogueId,
    revision: book.revision.revisionId,
    placements,
    limits: { maxDepth: 16, maxPlacements: 512 },
    canOrganize: book.revision.kind === 'structure',
  };
  return { ...structure, placements: bookTocRows(structure).map((row) => row.placement) };
}

/** UUIDv8 occurrence identity with Content's route bytes; stable for an exact command replay. */
export async function hostedOccurrenceId(catalogueId: string, idempotencyKey: string): Promise<string> {
  const route = hostedRoute(catalogueId);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['studio.hosted-occurrence', catalogueId, idempotencyKey])),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  bytes[10] = Number.parseInt(route.slice(0, 2), 16);
  bytes[11] = Number.parseInt(route.slice(2), 16);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

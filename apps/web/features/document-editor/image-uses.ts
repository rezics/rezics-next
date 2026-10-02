import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { BFF_PREFIX } from '../api/browser.ts';
import { imageReferenceFromUrl, resolveMediaMetadata } from '../api/media-metadata.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function images(document: DocumentSnapshot): DocumentNode[] {
  const result: DocumentNode[] = [];
  const visit = (node: DocumentNode) => { if (node.type === 'image') result.push(node); for (const child of node.content ?? []) visit(child); };
  visit(document.doc); return result;
}

/** Rebind copied occurrences; unchanged occurrences retain their immutable Use. Four owner calls run at most. */
export function imageUseReconciler(initial: DocumentSnapshot, actingSubject: string, target: string, send: typeof fetch = fetch) {
  const known = new Map<string, string>();
  const linked = new Map<string, Promise<string>>();
  const slots: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve());
  let nextSlot = 0;
  for (const node of images(initial)) {
    if (typeof node.attrs?.representationId === 'string' && typeof node.attrs.mediaUseId === 'string')
      known.set(`${node.attrs.id}:${node.attrs.representationId}`, node.attrs.mediaUseId);
  }
  return async (document: DocumentSnapshot, imported = false): Promise<DocumentSnapshot> => {
    const changes = new Map<DocumentNode, DocumentNode>();
    const nodes = images(document);
    for (let offset = 0; offset < nodes.length; offset += 4) {
      await Promise.all(nodes.slice(offset, offset + 4).map(async node => {
        const attrs = node.attrs ?? {};
        let reference = typeof attrs.representationId === 'string' ? { representationId: attrs.representationId,
          mediaUseId: typeof attrs.mediaUseId === 'string' ? attrs.mediaUseId : undefined }
          : imageReferenceFromUrl(String(attrs.src ?? ''));
        if (!reference) return;
        if (reference.representationId.startsWith('selection:')) {
          const metadata = (await resolveMediaMetadata([reference], actingSubject, send))[0];
          if (!metadata) throw new Error('image-reference-unavailable');
          reference = metadata;
        }
        const occurrence = typeof attrs.id === 'string' && uuid.test(attrs.id) ? attrs.id : crypto.randomUUID();
        const key = `${occurrence}:${reference.representationId}`;
        if (!imported && reference.mediaUseId && known.get(key) === reference.mediaUseId) return;
        let pending = linked.get(key);
        if (!pending) {
          const slot = nextSlot++ % slots.length;
          pending = slots[slot]!.then(() => send(`${BFF_PREFIX}/v1/media/uses`, { method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
            body: JSON.stringify({ actingSubject, target, representation: reference.representationId, occurrence, conceal: attrs.conceal === true }) }))
            .then(async response => {
              if (!response.ok) throw new Error('image-reference-not-created');
              const result = await response.json() as { use: string };
              if (!uuid.test(result.use)) throw new Error('invalid-image-reference');
              known.set(key, result.use); return result.use;
            }).catch(error => { linked.delete(key); throw error; });
          linked.set(key, pending);
          slots[slot] = pending.catch(() => {});
        }
        const use = await pending;
        changes.set(node, { ...node, attrs: { ...attrs, id: occurrence, representationId: reference.representationId,
          mediaUseId: use, src: `${BFF_PREFIX}/v1/media/representations/${reference.representationId}/bytes?use=${use}` } });
      }));
    }
    if (!changes.size) return document;
    const copy = (node: DocumentNode): DocumentNode => {
      if (changes.has(node)) return changes.get(node)!;
      if (!node.content) return node;
      const content = node.content.map(copy);
      return content.some((child, index) => child !== node.content![index]) ? { ...node, content } : node;
    };
    return { ...document, doc: copy(document.doc) };
  };
}

import { documentText, type DocumentSnapshot } from '@rezics/document';
import { checkedResourceReference, contentDocumentNodes, resourceReferenceProjection, type ResourceReference } from './adoption.ts';

/** Owner adapters prove membership and disclosure at the exact requested grain. */
export interface ReferenceOwners {
  resource(target: string): Promise<boolean>;
  revision(target: string, revision: string): Promise<boolean>;
  occurrence(target: string, structure: string, revision: string, occurrence: string): Promise<boolean>;
  content(target: string, variant: string, revision: string): Promise<{ document?: DocumentSnapshot; body: string } | null>;
  representation(target: string, revision: string, representation: string): Promise<{ duration?: number } | null>;
}
export type ReferenceResolution = { status: 'unavailable' } | {
  status: 'available'; reference: ResourceReference; document?: DocumentSnapshot; text?: string; projection: Record<string, unknown>;
};

/** No recursive expansion and no concealed target or fragment identifiers in refusals. */
export async function resolveResourceReference(value: ResourceReference, owners: ReferenceOwners): Promise<ReferenceResolution> {
  const reference = checkedResourceReference(value); const s = reference.selector;
  let document: DocumentSnapshot | undefined; let text: string | undefined; let available = false;
  switch (s.grain) {
    case 'resource': available = await owners.resource(reference.target); break;
    case 'revision': available = await owners.revision(reference.target, s.revision); break;
    case 'occurrence': available = await owners.occurrence(reference.target, s.structure, s.revision, s.occurrence); break;
    case 'content': {
      const content = await owners.content(reference.target, s.variantId, s.revision);
      if (!content) break;
      document = content.document; text = content.body; available = true;
      if (s.block) {
        const matches = document ? contentDocumentNodes(document).filter(node => node.attrs?.id === s.block) : [];
        const block = matches[0];
        if (!block || matches.length !== 1 || !document) { available = false; break; }
        // Inline units cannot become standalone documents; spans select text within a block.
        try { document = { ...document, doc: { type: 'doc', content: [block] } }; text = documentText(document); }
        catch { available = false; break; }
      }
      if (s.span) {
        if (!text || s.span.end > text.length) { available = false; break; }
        text = text.slice(s.span.start, s.span.end);
        if (Buffer.from(text, 'utf8').toString('utf8') !== text) { available = false; break; }
        document = undefined;
      }
      break;
    }
    case 'representation': {
      const representation = await owners.representation(reference.target, s.revision, s.representation);
      available = representation !== null;
      if (s.fragment) {
        const [start, end] = s.fragment.slice(6).split(',').map(Number);
        available = available && representation?.duration !== undefined
          && Number.isFinite(representation.duration) && start! >= 0 && end! > start!
          && end! <= representation.duration;
      }
      break;
    }
  }
  return available ? { status: 'available', reference, projection: resourceReferenceProjection(reference), ...(document ? { document } : {}),
    ...(text !== undefined ? { text } : {}) } : { status: 'unavailable' };
}

import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import { safeDocumentUrl } from '@rezics/ui/document-body';

export const readingOutlineLimit = 100;
export const readingOutlineLabelLimit = 120;
export const postReferenceLimit = 64;
export const postReferenceLabelLimit = 120;

export type ReadingOutlineEntry = Readonly<{
  /** Heading ordinal, never heading text or an address fragment. */
  position: number;
  nodeId: string;
  level: number;
  depth: number;
  label: string;
}>;

export type ReadingOutline = Readonly<{
  entries: readonly ReadingOutlineEntry[];
  byPosition: ReadonlyMap<number, ReadingOutlineEntry>;
  eligible: number;
  overflow: number;
}>;

export type PostReferenceEntry = Readonly<{
  /** Link-mark position used only to bind this disclosed source occurrence to the renderer. */
  position: number;
  /** Compact visible ordinal; concealed and unsupported links do not affect it. */
  ordinal: number;
  label: string;
  href: string;
  destination: 'web' | 'email';
  location: string;
}>;

export type PostReferenceList = Readonly<{
  entries: readonly PostReferenceEntry[];
  byPosition: ReadonlyMap<number, PostReferenceEntry>;
  eligible: number;
  overflow: number;
}>;

export type PostReadingProjection = Readonly<{
  outline: ReadingOutline;
  references: PostReferenceList;
}>;

const containers = new Set([
  'doc',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);
const inline = new Set(['text', 'hardBreak', 'ruby', 'mention', 'extensionInline']);
const marks = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'textStyle',
  'textEmphasis',
  'language',
  'spoiler',
]);

type Label = { characters: string[]; space: boolean; truncated: boolean; hidden: boolean };

function append(label: Label, text: string, limit: number) {
  if (label.hidden || label.truncated) return;
  for (const point of text) {
    if (/\s/u.test(point)) {
      label.space = label.characters.length > 0;
      continue;
    }
    if (label.space) {
      if (label.characters.length >= limit) {
        label.truncated = true;
        return;
      }
      label.characters.push(' ');
      label.space = false;
    }
    if (label.characters.length >= limit) {
      label.truncated = true;
      return;
    }
    label.characters.push(point);
  }
}

function finishLabel(label: Label, limit: number) {
  if (label.truncated) label.characters[limit - 1] = '…';
  return label.characters.join('');
}

function referenceDestination(value: unknown) {
  const href = safeDocumentUrl(value);
  if (!href) return null;
  const parsed = new URL(href);
  const destination = parsed.protocol === 'mailto:' ? 'email' : 'web';
  return {
    href,
    destination,
    location: destination === 'email' ? '' : parsed.hostname,
  } as const;
}

/**
 * Project one exact, already admitted snapshot and live disclosure set in a single iterative preorder walk.
 * Link positions follow the shared renderer's mark order, including concealed and unsupported marks. Only
 * disclosed text labels and URLs enter the bounded list; the full admitted snapshot is never copied.
 */
export function projectPostReading(
  document: DocumentSnapshot,
  revealed: ReadonlySet<number> = new Set(),
): PostReadingProjection {
  const outlineEntries: ReadingOutlineEntry[] = [];
  const outlineByPosition = new Map<number, ReadingOutlineEntry>();
  const referenceEntries: PostReferenceEntry[] = [];
  const referencesByPosition = new Map<number, PostReferenceEntry>();
  let headingEligible = 0;
  let headingPosition = 0;
  let linkPosition = 0;
  let referenceEligible = 0;
  let spoilerPosition = 0;
  const hierarchy: number[] = [];
  type Heading = { position: number; nodeId: string; level: number; label: Label };
  type Link = { position: number; readHref: () => unknown };
  type Frame = { node: DocumentNode; hidden: boolean; heading?: Heading; finish?: Heading };
  const stack: Frame[] = [{ node: document.doc, hidden: false }];

  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.finish) {
      const heading = frame.finish;
      if (heading.label.hidden || heading.label.characters.length === 0) continue;
      headingEligible++;
      if (outlineEntries.length === readingOutlineLimit) continue;
      while (hierarchy.length && hierarchy[hierarchy.length - 1]! >= heading.level) hierarchy.pop();
      const entry = {
        position: heading.position,
        nodeId: heading.nodeId,
        level: heading.level,
        depth: hierarchy.length,
        label: finishLabel(heading.label, readingOutlineLabelLimit),
      };
      outlineEntries.push(entry);
      outlineByPosition.set(entry.position, entry);
      hierarchy.push(heading.level);
      continue;
    }

    const node = frame.node;
    let hidden = frame.hidden || node.attrs?.conceal === true;
    const linkMarks: Link[] = [];
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') linkMarks.push({ position: linkPosition++, readHref: () => mark.attrs?.href });
      if (mark.type === 'spoiler') {
        const disclosed = revealed.has(spoilerPosition++);
        hidden ||= !disclosed;
      } else if (!marks.has(mark.type)) hidden = true;
    }

    let heading = frame.heading;
    if (node.type === 'heading') {
      const level = node.attrs?.level ?? 1;
      const nodeId = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
      hidden ||= !nodeId;
      heading = {
        position: headingPosition++,
        nodeId,
        level: typeof level === 'number' ? level : 1,
        label: { characters: [], space: false, truncated: false, hidden },
      };
      stack.push({ node, hidden, finish: heading });
    } else if (heading && !inline.has(node.type)) {
      // Admitted headings contain inline nodes. Do not guess the visibility of a new shape.
      heading.label.hidden = true;
    }

    if (heading) {
      heading.label.hidden ||= hidden;
      if (node.type === 'text' && !hidden) append(heading.label, node.text ?? '', readingOutlineLabelLimit);
      if (node.type === 'hardBreak' && !hidden) append(heading.label, ' ', readingOutlineLabelLimit);
    }

    // Mention nodes have an independent account disclosure and never become references.
    if (node.type === 'text' && !hidden && linkMarks.length) {
      for (const link of linkMarks) {
        const destination = referenceDestination(link.readHref());
        if (!destination) continue;
        referenceEligible++;
        if (referenceEntries.length === postReferenceLimit) continue;
        const label: Label = { characters: [], space: false, truncated: false, hidden: false };
        append(label, node.text ?? '', postReferenceLabelLimit);
        const entry = {
          position: link.position,
          ordinal: referenceEligible,
          label: finishLabel(label, postReferenceLabelLimit),
          ...destination,
        };
        referenceEntries.push(entry);
        referencesByPosition.set(entry.position, entry);
      }
    }

    const descend = node.type === 'heading' || containers.has(node.type) || (heading && inline.has(node.type));
    if (!descend && node.content?.length) hidden = true;
    const children = node.content ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      // Visit hidden or unsupported descendants only to keep renderer positions aligned; never read their text.
      stack.push({ node: children[index]!, hidden: hidden || !descend, ...(heading ? { heading } : {}) });
    }
  }

  return {
    outline: {
      entries: outlineEntries,
      byPosition: outlineByPosition,
      eligible: headingEligible,
      overflow: Math.max(0, headingEligible - outlineEntries.length),
    },
    references: {
      entries: referenceEntries,
      byPosition: referencesByPosition,
      eligible: referenceEligible,
      overflow: Math.max(0, referenceEligible - referenceEntries.length),
    },
  };
}

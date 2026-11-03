import type { DocumentNode, DocumentSnapshot } from '@rezics/document';

export const readingOutlineLimit = 100;
export const readingOutlineLabelLimit = 120;

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

const containers = new Set([
  'doc', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'table', 'tableRow', 'tableCell', 'tableHeader',
]);
const inline = new Set(['text', 'hardBreak', 'ruby', 'mention', 'extensionInline']);
const marks = new Set([
  'bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle', 'textEmphasis', 'language', 'spoiler',
]);

type Label = { characters: string[]; space: boolean; truncated: boolean; hidden: boolean };

/** Source text only: never read a URL, image alt, ruby annotation, component payload or mention label. */
function append(label: Label, text: string) {
  if (label.hidden || label.truncated) return;
  for (const point of text) {
    if (/\s/u.test(point)) {
      label.space = label.characters.length > 0;
      continue;
    }
    if (label.space) {
      if (label.characters.length >= readingOutlineLabelLimit) { label.truncated = true; return; }
      label.characters.push(' ');
      label.space = false;
    }
    if (label.characters.length >= readingOutlineLabelLimit) { label.truncated = true; return; }
    label.characters.push(point);
  }
}

/**
 * Input is the exact, already admitted snapshot, never serialized input. One iterative preorder walk per
 * snapshot/disclosure identity; no renderer, resolver, producer or DOM is involved. Spoiler positions follow
 * the shared renderer's mark order, including marks outside headings. Unsupported visibility is omitted.
 */
export function projectReadingOutline(
  document: DocumentSnapshot,
  revealed: ReadonlySet<number> = new Set(),
): ReadingOutline {
  const entries: ReadingOutlineEntry[] = [];
  const byPosition = new Map<number, ReadingOutlineEntry>();
  let eligible = 0;
  let headingPosition = 0;
  let spoilerPosition = 0;
  const hierarchy: number[] = [];
  type Heading = { position: number; nodeId: string; level: number; label: Label };
  type Frame = { node: DocumentNode; hidden: boolean; heading?: Heading; finish?: Heading };
  const stack: Frame[] = [{ node: document.doc, hidden: false }];
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.finish) {
      const heading = frame.finish;
      if (heading.label.hidden || heading.label.characters.length === 0) continue;
      eligible++;
      if (entries.length === readingOutlineLimit) continue;
      while (hierarchy.length && hierarchy[hierarchy.length - 1]! >= heading.level) hierarchy.pop();
      const label = heading.label.characters;
      if (heading.label.truncated) label[readingOutlineLabelLimit - 1] = '…';
      const entry = {
        position: heading.position, nodeId: heading.nodeId, level: heading.level, depth: hierarchy.length, label: label.join(''),
      };
      entries.push(entry);
      byPosition.set(entry.position, entry);
      hierarchy.push(heading.level);
      continue;
    }
    const node = frame.node;
    let hidden = frame.hidden || node.attrs?.conceal === true;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'spoiler') {
        const disclosed = revealed.has(spoilerPosition++);
        hidden ||= !disclosed;
      }
      else if (!marks.has(mark.type)) hidden = true;
    }
    let heading = frame.heading;
    if (node.type === 'heading') {
      const level = node.attrs?.level ?? 1;
      const nodeId = typeof node.attrs?.id === 'string' ? node.attrs.id : '';
      hidden ||= !nodeId;
      heading = {
        position: headingPosition++, nodeId, level: typeof level === 'number' ? level : 1,
        label: { characters: [], space: false, truncated: false, hidden },
      };
      stack.push({ node, hidden, finish: heading });
    } else if (heading && !inline.has(node.type)) {
      // Admitted headings contain inline nodes. Do not guess the visibility of a new shape.
      heading.label.hidden = true;
    }
    if (heading) {
      heading.label.hidden ||= hidden;
      if (node.type === 'text' && !hidden) append(heading.label, node.text ?? '');
      if (node.type === 'hardBreak' && !hidden) append(heading.label, ' ');
    }
    // Non-heading leaf blocks have no section structure. Their text is never read for labels.
    const descend = node.type === 'heading' || containers.has(node.type) || (heading && inline.has(node.type));
    if (!descend && node.content?.length) hidden = true;
    const children = node.content ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      // Visit even unsupported children to keep positional identities aligned, but never admit their labels.
      stack.push({ node: children[index]!, hidden: hidden || !descend, ...(heading ? { heading } : {}) });
    }
  }
  return { entries, byPosition, eligible, overflow: Math.max(0, eligible - entries.length) };
}

import type { DocumentNode, DocumentSnapshot } from '@rezics/document';

export const MAX_WIDE_DOCUMENT_BLOCKS = 64;
export const MAX_WIDE_CODE_BYTES = 128 * 1024;

export type WideDocumentKind = 'code' | 'table';

export type WideDocumentDescriptor = Readonly<{
  kind: WideDocumentKind;
  node: DocumentNode;
  order: number;
  codeBytes?: number;
}>;

type Metrics = Readonly<{
  hasHiddenContent: boolean;
  hasUnsupportedVisibility: boolean;
  hasUnsupportedTableContent: boolean;
  textBytes: number;
}>;

const noDisclosures: ReadonlySet<number> = new Set();

const tableNodeTypes = new Set(['table', 'tableRow', 'tableCell', 'tableHeader', 'paragraph', 'text', 'hardBreak']);

const tableMarkTypes = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'spoiler',
  'code',
  'language',
  'textStyle',
  'textEmphasis',
]);

/** Count UTF-8 bytes without making a second copy of authored text. */
function boundedUtf8Length(value: string, maximum: number): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes >= maximum) return maximum;
  }
  return bytes;
}

/**
 * Register at most 64 disclosed code and plain-table nodes in authored order. The post-order walk
 * records only bounded metadata; it keeps no serialized or rendered copy of the document.
 */
export function registerWideDocumentBlocks(
  snapshot: DocumentSnapshot,
  disclosedSpoilers: ReadonlySet<number> = noDisclosures,
): readonly WideDocumentDescriptor[] {
  const metrics = new WeakMap<DocumentNode, Metrics>();
  const order = new WeakMap<DocumentNode, number>();
  const found: WideDocumentDescriptor[] = [];
  const stack: Array<{ node: DocumentNode; exit: boolean; hidden: boolean; unsupportedVisibility: boolean }> = [
    { node: snapshot.doc, exit: false, hidden: false, unsupportedVisibility: false },
  ];
  let nextOrder = 0;
  let spoilerPosition = 0;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const { node } = entry;
    if (!entry.exit) {
      order.set(node, nextOrder++);
      let hidden = entry.hidden || node.attrs?.conceal === true;
      let unsupportedVisibility = entry.unsupportedVisibility;
      for (const mark of node.marks ?? []) {
        if (mark.type === 'spoiler') hidden ||= !disclosedSpoilers.has(spoilerPosition++);
        else if (!tableMarkTypes.has(mark.type)) unsupportedVisibility = true;
      }
      stack.push({ node, exit: true, hidden, unsupportedVisibility });
      const children = node.content ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: children[index]!,
          exit: false,
          hidden,
          unsupportedVisibility,
        });
      }
      continue;
    }

    let hasUnsupportedTableContent =
      !tableNodeTypes.has(node.type) || (node.marks?.some((mark) => !tableMarkTypes.has(mark.type)) ?? false);
    let hasHiddenContent = entry.hidden;
    let hasUnsupportedVisibility = entry.unsupportedVisibility;
    let textBytes =
      !entry.hidden && node.type === 'text' ? boundedUtf8Length(node.text ?? '', MAX_WIDE_CODE_BYTES + 1) : 0;

    for (const child of node.content ?? []) {
      const childMetrics = metrics.get(child);
      if (!childMetrics) continue;
      hasHiddenContent ||= childMetrics.hasHiddenContent;
      hasUnsupportedVisibility ||= childMetrics.hasUnsupportedVisibility;
      hasUnsupportedTableContent ||= childMetrics.hasUnsupportedTableContent;
      textBytes = Math.min(MAX_WIDE_CODE_BYTES + 1, textBytes + childMetrics.textBytes);
    }

    metrics.set(node, { hasHiddenContent, hasUnsupportedVisibility, hasUnsupportedTableContent, textBytes });
    if (hasUnsupportedVisibility || hasHiddenContent || found.length >= MAX_WIDE_DOCUMENT_BLOCKS) continue;

    if (node.type === 'codeBlock') {
      found.push({ kind: 'code', node, order: order.get(node) ?? 0, codeBytes: textBytes });
    } else if (node.type === 'table' && !hasUnsupportedTableContent) {
      found.push({ kind: 'table', node, order: order.get(node) ?? 0 });
    }
  }

  found.sort((left, right) => left.order - right.order);
  return found;
}

/** Extract only the selected admitted code node, retaining its exact text and line endings. */
export function extractSelectedCode(descriptor: WideDocumentDescriptor): string {
  if (descriptor.kind !== 'code' || descriptor.node.type !== 'codeBlock') {
    throw new TypeError('The selected document block is not code.');
  }
  if ((descriptor.codeBytes ?? MAX_WIDE_CODE_BYTES + 1) > MAX_WIDE_CODE_BYTES) {
    throw new RangeError('The selected code block exceeds the copy limit.');
  }

  const chunks: string[] = [];
  const stack = [descriptor.node];
  let byteLength = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'text') {
      const text = node.text ?? '';
      byteLength += boundedUtf8Length(text, MAX_WIDE_CODE_BYTES + 1);
      if (byteLength > MAX_WIDE_CODE_BYTES) throw new RangeError('The selected code block exceeds the copy limit.');
      chunks.push(text);
      continue;
    }
    const children = node.content ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return chunks.join('');
}

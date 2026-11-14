import { expect, waitFor } from 'storybook/test';

/** Contenteditable selection uses the browser Range API; input.setSelectionRange does not apply to an editor. */
export async function placeEditorCaret(root: HTMLElement, content: HTMLElement = root) {
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(content);
  range.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await waitFor(() => expect(content.contains(window.getSelection()?.anchorNode ?? null)).toBe(true));
}

export async function selectEditorText(root: HTMLElement, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: { node: Node; from: number; to: number }[] = [];
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    found.push({ node, from: offset, to: offset + (node.textContent?.length ?? 0) });
    offset += node.textContent?.length ?? 0;
  }
  const from = (root.textContent ?? '').indexOf(text);
  if (from < 0) throw new Error(`Text not found: ${text}`);
  const first = found.find((part) => part.to > from)!;
  const last = found.find((part) => part.to >= from + text.length)!;
  root.focus();
  const range = document.createRange();
  range.setStart(first.node, from - first.from);
  range.setEnd(last.node, from + text.length - last.from);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await waitFor(() => expect(window.getSelection()?.toString()).toBe(text));
}

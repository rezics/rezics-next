import { Extension, type Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { DocumentProfile } from '@rezics/document';
import { parseComponentAttributes, parseImageAttributes, parseMediaAttributes } from './document-component-data.ts';
import { validFormattingMetadata } from './document-style.ts';
import { editorSnapshot, maxSnapshotBytes } from './rich-text-editor-snapshot.ts';

/** Inspect the original HTML before its schema parser can omit malformed structured metadata. */
export function validateStructuredPastedHTML(html: string, admitted?: ReadonlySet<string>): boolean {
  // Canonical node data may be repeated and HTML-escaped in a clipboard representation.
  if (html.length > maxSnapshotBytes * 16) return false;
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  if (!validFormattingMetadata(root)) return false;
  for (const image of root.querySelectorAll('img')) if (!image.getAttribute('src')?.trim()) return false;
  for (const element of root.querySelectorAll<HTMLElement>('[data-document-component]')) {
    const type = element.tagName === 'SPAN' ? 'extensionInline' : element.tagName === 'DIV' ? 'extensionBlock' : '';
    if (!type || (admitted && !admitted.has(type)) || !parseComponentAttributes(element)) return false;
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-document-image]'))
    if (element.tagName !== 'FIGURE' || (admitted && !admitted.has('image')) || !parseImageAttributes(element))
      return false;
  for (const element of root.querySelectorAll<HTMLElement>('[data-document-media]'))
    if (element.tagName !== 'FIGURE' || (admitted && !admitted.has('media')) || !parseMediaAttributes(element))
      return false;
  if (
    admitted &&
    ((!admitted.has('table') && root.querySelector('table')) ||
      (!admitted.has('image') && root.querySelector('img')) ||
      (!admitted.has('media') && root.querySelector('figure[data-media]')))
  )
    return false;
  return true;
}

export const StructuredDocumentClipboard = Extension.create<{
  profile: DocumentProfile;
  plainText?: (editor: Editor) => boolean;
  onInvalidContent?: (reason?: 'structuredPaste') => void;
}>({
  name: 'structuredDocumentClipboard',
  priority: 1_000,
  addOptions: () => ({ profile: 'blocks' }),
  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    const admitted = new Set(Object.keys(editor.schema.nodes));
    const accepts = (html: string) => !html || validateStructuredPastedHTML(html, admitted);
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            if (options.plainText?.(editor) || accepts(event.clipboardData?.getData('text/html') ?? '')) return false;
            options.onInvalidContent?.('structuredPaste');
            return true;
          },
          handleDrop(_view, event, _slice, moved) {
            if (moved || accepts(event.dataTransfer?.getData('text/html') ?? '')) return false;
            options.onInvalidContent?.('structuredPaste');
            return true;
          },
        },
        filterTransaction(transaction) {
          const event = transaction.getMeta('uiEvent');
          if (!transaction.docChanged || !['paste', 'drop'].includes(event)) return true;
          try {
            editorSnapshot(transaction.doc, options.profile);
            return true;
          } catch {
            options.onInvalidContent?.('structuredPaste');
            return false;
          }
        },
      }),
    ];
  },
});

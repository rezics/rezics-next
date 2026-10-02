'use client';

import type { Editor as TiptapEditor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { CheckIcon, ExternalLinkIcon, PencilIcon, UnlinkIcon, XIcon } from 'lucide-react';
import { memo, useState, type RefObject } from 'react';
import { Button } from './button.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';
import { bubbleOptions } from './editor-surface.ts';
import { safeDocumentUrl } from './document-url.tsx';
import { Field } from './field.tsx';
import { Input } from './input.tsx';

export interface LinkRange { from: number; to: number }

/** Sets, replaces or removes the link on a range. An empty range with no link inserts the address as linked text. */
export function applyLink(editor: TiptapEditor, range: LinkRange, href: string | null) {
  const chain = editor.chain().focus().setTextSelection(range);
  if (!href) chain.extendMarkRange('link').unsetLink().run();
  else if (range.from === range.to && !editor.isActive('link')) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
  else chain.extendMarkRange('link').setLink({ href }).run();
}

/** An address field that edits the link on a saved range in place, so a link never needs a dialog while its text is in view. */
export function LinkField({ editor, labels, range, onClose }: { editor: TiptapEditor; labels: RichTextEditorLabels; range: LinkRange; onClose: () => void }) {
  const [url, setUrl] = useState(() => String(editor.getAttributes('link').href ?? ''));
  const [invalid, setInvalid] = useState(false);
  const linked = editor.isActive('link');
  function finish(href: string | null) {
    if (href && !safeDocumentUrl(href)) { setInvalid(true); return; }
    applyLink(editor, range, href);
    onClose();
  }
  function cancel() { editor.chain().focus().setTextSelection(range).run(); onClose(); }
  return <form className="grid gap-1" onSubmit={event => { event.preventDefault(); finish(url.trim() || null); }}>
    <div className="flex items-center gap-1">
      <Field invalid={invalid} className="min-w-0 flex-1">
        <Input size="sm" autoFocus dir="ltr" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label={labels.url}
          aria-invalid={invalid} value={url} onChange={event => { setUrl(event.target.value); setInvalid(false); }}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }} />
      </Field>
      <Button type="submit" size="icon-sm" variant="soft" aria-label={labels.apply} title={labels.apply}><CheckIcon aria-hidden="true" /></Button>
      {linked ? <Button type="button" size="icon-sm" variant="ghost" aria-label={labels.unlink} title={labels.unlink} onClick={() => finish(null)}><UnlinkIcon aria-hidden="true" /></Button> : null}
      <Button type="button" size="icon-sm" variant="ghost" aria-label={labels.cancel} title={labels.cancel} onClick={cancel}><XIcon aria-hidden="true" /></Button>
    </div>
    {invalid ? <p role="alert" className="px-1 text-xs text-destructive">{labels.invalidUrl}</p> : null}
  </form>;
}

/** Appears while the caret rests inside a link: where it goes, and the three things to do with it. */
export const LinkMenu = memo(function LinkMenu({ editor, labels, linkRange, onEdit, onClose, container }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; linkRange: LinkRange | null; onEdit: () => void; onClose: () => void;
  /** Where the card is placed: outside the document, so the document's own styles never reach it. */
  container: RefObject<HTMLElement | null>;
}) {
  const href = useEditorState({ editor, selector: ({ editor: current }) => String(current.getAttributes('link').href ?? '') });
  const safe = safeDocumentUrl(href);
  return <BubbleMenu editor={editor} pluginKey="rezicsLinkMenu" updateDelay={80} options={{ ...bubbleOptions, placement: 'bottom' }}
    appendTo={() => container.current ?? editor.view.dom.parentElement ?? document.body}
    shouldShow={({ editor: current, element, view, state }) => current.isEditable && state.selection.empty && current.isActive('link')
      && (view.hasFocus() || element.contains(document.activeElement))}
    className="max-w-[calc(100vw-1rem)]" data-slot="editor-link-menu">
    <div role="group" aria-label={labels.link} className="w-72 max-w-full rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-(--aura-shadow-float)"
      onMouseDown={event => { if (!(event.target as HTMLElement).closest('input')) event.preventDefault(); }}>
      {linkRange ? <LinkField editor={editor} labels={labels} range={linkRange} onClose={onClose} /> : <div className="flex items-center gap-1">
        <span dir="ltr" className="min-w-0 flex-1 truncate ps-2 text-sm text-muted-foreground" title={href}>{href}</span>
        {safe ? <Button asChild size="icon-sm" variant="ghost" title={labels.openLink}><a href={safe} target="_blank" rel="noopener noreferrer" aria-label={labels.openLink}><ExternalLinkIcon aria-hidden="true" /></a></Button> : null}
        <Button size="icon-sm" variant="ghost" aria-label={labels.editLink} title={labels.editLink} onClick={onEdit}><PencilIcon aria-hidden="true" /></Button>
        <Button size="icon-sm" variant="ghost" aria-label={labels.unlink} title={labels.unlink} onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); }}><UnlinkIcon aria-hidden="true" /></Button>
      </div>}
    </div>
  </BubbleMenu>;
});

'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldError } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useId, useState, type RefObject } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { bubbleOptions } from './editor-selection-menu.tsx';
import { safeDocumentUrl } from './document-url.ts';

export interface LinkRange {
  from: number;
  to: number;
}

/** Validate at the mutation boundary as well as in the address field. */
export function applyLink(editor: Editor, range: LinkRange, href: string | null): boolean {
  if (!editor.schema.marks.link || (href !== null && !safeDocumentUrl(href))) return false;
  const chain = editor.chain().focus().setTextSelection(range).extendMarkRange('link');
  if (href === null) return chain.unsetMark('link').run();
  if (range.from === range.to && !editor.isActive('link')) {
    return chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
  }
  return chain.setMark('link', { href }).run();
}

/**
 * Inline address editing on a saved document range. The bubble menu places it against the text, which a shadcn popover
 * cannot do: its anchor is a trigger element, not a range in the document.
 */
export function LinkField({
  editor,
  labels,
  range,
  onClose,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  range: LinkRange;
  onClose: () => void;
}) {
  const errorId = useId();
  const [url, setUrl] = useState(() => String(editor.getAttributes('link').href ?? ''));
  const [invalid, setInvalid] = useState(false);
  const linked = editor.isActive('link');
  function finish(href: string | null) {
    if (href !== null && !safeDocumentUrl(href)) {
      setInvalid(true);
      return;
    }
    if (applyLink(editor, range, href)) onClose();
  }
  function cancel() {
    editor.chain().focus().setTextSelection(range).run();
    onClose();
  }
  return (
    <form
      className="grid gap-2 p-1"
      onSubmit={(event) => {
        event.preventDefault();
        finish(url.trim() || null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <Field orientation="horizontal" className="flex-wrap items-center gap-1">
        <Input
          autoFocus
          dir="ltr"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-40 flex-1 text-foreground"
          aria-label={labels.url}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="secondary">
          {labels.apply}
        </Button>
        {linked ? (
          <Button type="button" variant="ghost" onClick={() => finish(null)}>
            {labels.unlink}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={cancel}>
          {labels.cancel}
        </Button>
      </Field>
      {invalid ? <FieldError id={errorId}>{labels.invalidUrl}</FieldError> : null}
    </form>
  );
}

export function LinkMenu({
  editor,
  labels,
  range,
  onEdit,
  onClose,
  container,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  range: LinkRange | null;
  onEdit: () => void;
  onClose: () => void;
  container: RefObject<HTMLDivElement | null>;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      empty: current.state.selection.empty,
      linked: current.isActive('link'),
      href: String(current.getAttributes('link').href ?? ''),
    }),
  });
  if (!state.empty || (!state.linked && !range)) return null;
  const safe = safeDocumentUrl(state.href);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="rezicsLinkMenu"
      updateDelay={0}
      options={{ ...bubbleOptions, placement: 'bottom' }}
      appendTo={() => container.current!}
      shouldShow={({ view, element }) =>
        editor.isEditable && (view.hasFocus() || element.contains(document.activeElement))
      }
    >
      <div
        role="group"
        aria-label={labels.link}
        className="flex max-w-80 flex-col gap-1 rounded-2xl bg-popover p-2 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            editor.commands.focus();
          }
        }}
      >
        {range ? (
          <LinkField editor={editor} labels={labels} range={range} onClose={onClose} />
        ) : (
          <>
            {safe ? (
              <a
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={labels.openLink}
                className="block truncate rounded-lg px-2 py-1 text-sm text-primary underline underline-offset-2"
              >
                {state.href}
              </a>
            ) : null}
            <Button variant="ghost" onClick={onEdit}>
              {labels.editLink}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
              }}
            >
              {labels.unlink}
            </Button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

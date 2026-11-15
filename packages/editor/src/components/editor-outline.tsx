'use client';

import { Button } from '@rezics/ui/shadcn/button';
import type { Editor } from '@tiptap/core';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { useDeferredValue, useMemo } from 'react';
import { editorLabel, type EditorWorkbenchLabels } from './editor-workbench-labels.ts';

/** One bounded projection, computed only while inspection is open. */
export function editorOutline(doc: DocumentNode) {
  const headings: { id: string; text: string; level: number; position: number }[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === 'heading' && headings.length < 256)
      headings.push({
        id: String(node.attrs.id ?? position),
        text: node.textContent,
        level: Number(node.attrs.level),
        position,
      });
  });
  const text = doc.textBetween(0, doc.content.size, '\n', ' ');
  const characters = Array.from(text).length;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const words =
    (text
      .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0) + cjk;
  return { headings, words, characters, minutes: Math.max(1, Math.ceil(words / 220)) };
}

export function EditorOutline({
  editor,
  labels,
  isCurrent,
}: {
  editor: Editor;
  labels: EditorWorkbenchLabels;
  isCurrent: () => boolean;
}) {
  const doc = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc });
  const deferred = useDeferredValue(doc);
  const outline = useMemo(() => editorOutline(deferred), [deferred]);
  return (
    <section aria-label={labels.outline} className="flex min-w-0 flex-col gap-3 rounded-xl border p-3">
      <div className="flex min-w-0 flex-wrap gap-4 text-sm wrap-break-word text-muted-foreground" role="status">
        <span>{editorLabel(labels.wordCount, { count: outline.words })}</span>
        <span>{editorLabel(labels.characterCount, { count: outline.characters })}</span>
        <span>{editorLabel(labels.readingTime, { count: outline.minutes })}</span>
      </div>
      {outline.headings.length ? (
        <nav aria-label={labels.outline} className="flex max-h-64 w-full min-w-0 flex-col gap-1 overflow-y-auto">
          {outline.headings.map((heading) => (
            <Button
              key={heading.id}
              type="button"
              variant="ghost"
              className="h-auto w-full min-w-0 max-w-full shrink justify-start whitespace-normal wrap-break-word text-start"
              style={{ paddingInlineStart: `${0.75 * Math.min(Math.max(heading.level, 1) - 1, 5) + 0.75}rem` }}
              onClick={() => {
                if (!isCurrent()) return;
                let position: number | undefined;
                editor.state.doc.descendants((node, at) => {
                  if (node.type.name === 'heading' && String(node.attrs.id ?? at) === heading.id) position = at + 1;
                });
                if (position === undefined) return;
                editor.view.dispatch(
                  editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position))).scrollIntoView(),
                );
                editor.view.focus();
              }}
            >
              {heading.text || `H${heading.level}`}
            </Button>
          ))}
        </nav>
      ) : (
        <p className="min-w-0 text-sm wrap-break-word text-muted-foreground">{labels.outlineEmpty}</p>
      )}
    </section>
  );
}

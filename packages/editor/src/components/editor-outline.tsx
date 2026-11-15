'use client';

import { Button } from '@rezics/ui/shadcn/button';
import type { Editor } from '@tiptap/core';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { ChevronDown, X } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { editorLabel, type EditorWorkbenchLabels } from './editor-workbench-labels.ts';
import { unspacedScript, wordSegmenter } from './editor-text-segmentation.ts';

const headingLimit = 256;

type Heading = { id: string; text: string; level: number; position: number };
type HeadingBranch = Heading & { children: HeadingBranch[] };

/** Collect outline and counts in one deferred pass over text blocks. */
export function editorOutline(doc: DocumentNode, locale?: string) {
  const headings: Heading[] = [];
  let totalHeadings = 0;
  let words = 0;
  let characters = 0;
  const segmenter = wordSegmenter(locale);
  doc.descendants((node, position) => {
    if (node.type.name === 'heading') {
      totalHeadings += 1;
      if (headings.length < headingLimit)
        headings.push({
          id: String(node.attrs.id ?? position),
          text: node.textContent,
          level: Number(node.attrs.level),
          position,
        });
    }
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, '', ' ');
    for (const character of text) {
      if (!/^\s$/u.test(character)) characters += 1;
    }
    if (segmenter && unspacedScript.test(text)) {
      for (const segment of segmenter.segment(text)) if (segment.isWordLike) words += 1;
    } else {
      const matches = text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
      words += matches?.length ?? 0;
    }
    return false;
  });
  return { headings, totalHeadings, words, characters, minutes: Math.ceil(words / 220) };
}

function groupHeadings(headings: readonly Heading[]): HeadingBranch[] {
  const roots: HeadingBranch[] = [];
  const parents: HeadingBranch[] = [];
  for (const heading of headings) {
    const branch = { ...heading, children: [] };
    while (parents.at(-1) && parents.at(-1)!.level >= heading.level) parents.pop();
    (parents.at(-1)?.children ?? roots).push(branch);
    parents.push(branch);
  }
  return roots;
}

function LocalOutline({
  editor,
  labels,
  isCurrent,
}: {
  editor: Editor;
  labels: EditorWorkbenchLabels;
  isCurrent: () => boolean;
}) {
  const doc = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc });
  const caret = useEditorState({ editor, selector: ({ editor: current }) => current.state.selection.head });
  const deferred = useDeferredValue(doc);
  const locale = editor.view.dom.getAttribute('lang') ?? undefined;
  const outline = useMemo(() => editorOutline(deferred, locale), [deferred, locale]);
  const tree = useMemo(() => groupHeadings(outline.headings), [outline.headings]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const currentId = outline.headings.findLast((heading) => heading.position < caret)?.id;
  function jump(heading: Heading) {
    if (!isCurrent() || editor.view.composing) return;
    const live = editor.state.doc;
    let position = live === deferred ? heading.position : undefined;
    if (position === undefined)
      live.descendants((node, at) => {
        if (node.type.name === 'heading' && String(node.attrs.id ?? at) === heading.id) position = at;
      });
    if (position === undefined) return;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(live.resolve(position + 1))).scrollIntoView(),
    );
    if (editor.isEditable) editor.view.focus();
  }
  function renderTree(branches: readonly HeadingBranch[], nested = false): ReactNode {
    return (
      <ul className={nested ? 'ms-3 border-s ps-1' : undefined}>
        {branches.map((heading) => {
          const name = heading.text || `H${heading.level}`;
          const open = !collapsed.has(heading.id);
          return (
            <li key={heading.id}>
              <div className="flex items-start gap-0.5">
                <Button
                  type="button"
                  variant={currentId === heading.id ? 'secondary' : 'ghost'}
                  aria-current={currentId === heading.id ? 'location' : undefined}
                  className="h-auto min-h-7 min-w-0 flex-1 justify-start whitespace-normal wrap-break-word text-start"
                  onClick={() => jump(heading)}
                >
                  {name}
                </Button>
                {heading.children.length ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-expanded={open}
                    aria-label={name}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(heading.id)) next.delete(heading.id);
                        else next.add(heading.id);
                        return next;
                      })
                    }
                  >
                    <ChevronDown aria-hidden="true" className={open ? undefined : '-rotate-90'} />
                  </Button>
                ) : null}
              </div>
              {open && heading.children.length ? renderTree(heading.children, true) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{editorLabel(labels.wordCount, { count: outline.words })}</span>
        <span>{editorLabel(labels.characterCount, { count: outline.characters })}</span>
        <span>{editorLabel(labels.readingTime, { count: outline.minutes })}</span>
      </p>
      {tree.length ? (
        <nav aria-label={labels.outline} className="min-w-0">
          {renderTree(tree)}
          {outline.totalHeadings > outline.headings.length ? (
            <p className="pt-2 text-xs text-muted-foreground">
              {outline.headings.length} / {outline.totalHeadings}
            </p>
          ) : null}
        </nav>
      ) : (
        <p className="text-sm text-muted-foreground">{labels.outlineEmpty}</p>
      )}
    </>
  );
}

export function EditorOutline({
  editor,
  labels,
  isCurrent,
  onClose,
  children,
}: {
  editor: Editor;
  labels: EditorWorkbenchLabels;
  isCurrent: () => boolean;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const close = () => {
    if (!isCurrent() || !onClose) return;
    onClose();
    if (editor.isEditable) editor.view.focus();
    else editor.view.dom.focus({ preventScroll: true });
  };
  return (
    <section
      aria-label={labels.outline}
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-popover p-3 text-popover-foreground"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || !onClose) return;
        event.preventDefault();
        close();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{labels.outline}</h2>
        {onClose ? (
          <Button type="button" size="icon" variant="ghost" aria-label={labels.close} onClick={close}>
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {children ?? <LocalOutline editor={editor} labels={labels} isCurrent={isCurrent} />}
    </section>
  );
}

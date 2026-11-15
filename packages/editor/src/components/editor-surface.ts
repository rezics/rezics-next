import {
  Extension,
  InputRule,
  markInputRule,
  textblockTypeInputRule,
  wrappingInputRule,
  type Editor,
  type Extensions,
} from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { IdentityUniqueID } from './editor-identity-replay.ts';
import type { DocumentProfile } from '@rezics/document';
import { identifiableNodeNames, textNodeNames, blocksNodeNames } from '@rezics/document';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { EditorContent } from '@tiptap/react';
import { createElement, type CompositionEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@rezics/ui/utils';
import { safeDocumentUrl } from './document-url.ts';
import { documentExtensionsForProfile } from './document-extensions.ts';
import { EditorTables } from './editor-table-commands.ts';
import { EditorLists, withTaskItemView } from './editor-list-behavior.ts';
import { Prose } from './prose.tsx';
import { sanitizeFormattingStyle } from './document-style.ts';
import { StructuredDocumentClipboard } from './editor-clipboard.ts';
import { normalizeMediaClipboardDOM } from './document-component-data.ts';

function textLength(doc: Editor['state']['doc']): number {
  return Array.from(doc.textBetween(0, doc.content.size, '\n', ' ')).length;
}

export interface EditorInputSettings {
  markdownShortcuts: boolean;
  autoLink: boolean;
  paste: 'rich' | 'plain';
}

const defaultInputSettings: EditorInputSettings = { markdownShortcuts: true, autoLink: true, paste: 'rich' };

export function editorInputSettings(editor: Editor): EditorInputSettings {
  const storage = editor.storage as { documentInput?: EditorInputSettings };
  return (storage.documentInput ??= { ...defaultInputSettings });
}

/** Mutable input policy is private presentation state, outside document bytes and editor recreation. */
export function setEditorInputSettings(editor: Editor, settings: Partial<EditorInputSettings>): void {
  Object.assign(editorInputSettings(editor), settings);
}

const EditorInput = Extension.create<Record<string, never>, EditorInputSettings>({
  name: 'documentInput',
  addStorage: () => ({ ...defaultInputSettings }),
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          transformPasted(slice) {
            if (editorInputSettings(editor).paste !== 'plain') return slice;
            const text = slice.content.textBetween(0, slice.content.size, '\n', (node) =>
              node.type.name === 'hardBreak'
                ? '\n'
                : node.type.name === 'footnoteReference'
                  ? `[^${node.attrs.label}]`
                  : (node.attrs.fallback ?? node.attrs.alt ?? node.attrs.caption ?? ''),
            );
            if (!text) return Slice.empty;
            if (!text.includes('\n')) return new Slice(Fragment.from(editor.schema.text(text)), 0, 0);
            const paragraphs = text
              .split('\n')
              .map((line) => editor.schema.nodes.paragraph!.create(null, line ? editor.schema.text(line) : undefined));
            return new Slice(Fragment.fromArray(paragraphs), 1, 1);
          },
        },
        appendTransaction(transactions, _oldState, state) {
          if (
            !editorInputSettings(editor).autoLink ||
            editor.view.composing ||
            !transactions.some((transaction) => transaction.docChanged) ||
            transactions.some((transaction) => transaction.getMeta('documentAutoLink')) ||
            !state.selection.empty
          )
            return;
          const link = state.schema.marks.link;
          const { $from } = state.selection;
          if (!link || !$from.parent.isTextblock || !$from.parent.type.allowsMarkType(link)) return;
          const preceding = $from.parent.textBetween(
            Math.max(0, $from.parentOffset - 2048),
            $from.parentOffset,
            '',
            '\ufffc',
          );
          const match = /((?:https?:\/\/|mailto:)[^\s<>\ufffc]+)\s$/.exec(preceding);
          if (!match) return;
          const href = safeDocumentUrl(match[1]!);
          if (!href) return;
          const to = $from.pos - 1;
          const from = to - match[1]!.length;
          let ordinaryText = true;
          state.doc.nodesBetween(from, to, (node) => {
            if (node.isInline && (!node.isText || node.marks.some((mark) => ['link', 'code'].includes(mark.type.name))))
              ordinaryText = false;
          });
          return ordinaryText
            ? state.tr.addMark(from, to, link.create({ href })).setMeta('documentAutoLink', true)
            : undefined;
        },
      }),
    ];
  },
});

const LengthLimit = Extension.create<{ limit: number }>({
  name: 'richTextLengthLimit',
  addOptions: () => ({ limit: Infinity }),
  addProseMirrorPlugins() {
    const limit = this.options.limit;
    if (!Number.isFinite(limit)) return [];

    let view: { composing: boolean } | undefined;
    return [
      new Plugin({
        view: (editorView) => {
          view = editorView;
          return {
            destroy: () => {
              view = undefined;
            },
          };
        },
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged || view?.composing) return true;
          const nextLength = textLength(transaction.doc);
          return nextLength <= limit || nextLength <= textLength(state.doc);
        },
      }),
    ];
  },
});

/** Markdown rules for nodes and marks that exist in the editor schema. */
const MarkdownShortcuts = Extension.create({
  name: 'markdownShortcuts',
  addInputRules() {
    const schema = this.editor.schema;
    const rules = [];
    const heading = schema.nodes.heading;
    const blockquote = schema.nodes.blockquote;
    const bulletList = schema.nodes.bulletList;
    const orderedList = schema.nodes.orderedList;

    if (heading) {
      rules.push(
        textblockTypeInputRule({
          find: /^(#{1,6})\s$/,
          type: heading,
          getAttributes: (match) => ({ level: match[1]!.length }),
        }),
      );
    }
    if (blockquote) rules.push(wrappingInputRule({ find: /^>\s$/, type: blockquote }));
    if (bulletList) rules.push(wrappingInputRule({ find: /^[-+*]\s$/, type: bulletList }));
    if (orderedList) {
      rules.push(
        wrappingInputRule({
          find: /^(\d+)\.\s$/,
          type: orderedList,
          getAttributes: (match) => ({ start: Math.max(1, Number(match[1]) || 1) }),
        }),
      );
    }

    const shortcuts = [
      ['bold', /\*\*([^*]+)\*\*$/],
      ['italic', /(?<!\*)\*([^*]+)\*(?!\*)$/],
      ['strike', /~~([^~]+)~~$/],
      ['code', /`([^`]+)`$/],
    ] as const;
    for (const [name, find] of shortcuts) {
      const type = schema.marks[name];
      if (type) rules.push(markInputRule({ find, type }));
    }

    const editor = this.editor;
    return rules.map(
      (rule) =>
        new InputRule({
          find: rule.find,
          handler: (props) =>
            editorInputSettings(editor).markdownShortcuts && !editor.view.composing ? rule.handler(props) : null,
        }),
    );
  },
});

export function editorExtensions(
  profile: DocumentProfile,
  options: {
    placeholder?: string;
    maxLength?: number;
    readOnly?: boolean;
    taskStatus?: () => string;
    onInvalidContent?: (reason?: 'structuredPaste') => void;
  } = {},
): Extensions {
  const profileNodeNames = profile === 'text' ? textNodeNames : blocksNodeNames;
  const permittedNodes = new Set<string>(profileNodeNames);
  const uniqueTypes = [...identifiableNodeNames].filter((name) => permittedNodes.has(name));
  return [
    ...withTaskItemView(documentExtensionsForProfile(profile), options.taskStatus ?? (() => 'Task status')),
    EditorInput,
    StructuredDocumentClipboard.configure({
      profile,
      plainText: (editor) => editorInputSettings(editor).paste === 'plain',
      ...(options.onInvalidContent ? { onInvalidContent: options.onInvalidContent } : {}),
    }),
    ...(options.readOnly ? [] : [EditorLists]),
    ...(profile === 'blocks' && !options.readOnly
      ? [EditorTables.configure(options.onInvalidContent ? { onInvalidContent: options.onInvalidContent } : {})]
      : []),
    Placeholder.configure({ placeholder: options.placeholder ?? '' }),
    IdentityUniqueID.configure({
      types: uniqueTypes,
      generateID: () => crypto.randomUUID(),
      updateDocument: !options.readOnly,
    }),
    MarkdownShortcuts,
    ...(options.maxLength === undefined ? [] : [LengthLimit.configure({ limit: options.maxLength })]),
  ];
}

/** Remove executable and non-document markup before ProseMirror parses pasted HTML. */
export function sanitizePastedHTML(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const parsed = template.content;
  parsed
    .querySelectorAll('script,style,iframe,object,embed,svg,math,form,template,base,meta,link')
    .forEach((node) => node.remove());
  normalizeMediaClipboardDOM(parsed);

  for (const element of parsed.querySelectorAll('*')) {
    if (element.hasAttribute('style')) sanitizeFormattingStyle(element as HTMLElement);
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['srcdoc', 'formaction', 'action', 'srcset', 'xlink:href'].includes(name)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'href' && !safeDocumentUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'src' && !safeDocumentUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return template.innerHTML;
}

export interface EditorSurfaceProps {
  editor: Editor | null;
  label: string;
  lang?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLDivElement>) => void;
}

export function EditorSurface({
  editor,
  label,
  lang,
  dir,
  compact = false,
  disabled = false,
  className,
  onKeyDown,
  onKeyDownCapture,
  onCompositionEnd,
}: EditorSurfaceProps): ReactNode {
  return createElement(
    'div',
    {
      className: cn('min-w-0 rounded-2xl border border-border/60 bg-background', disabled && 'opacity-64', className),
      'data-slot': 'rich-text-editor',
      onKeyDown,
      onKeyDownCapture,
      onCompositionEnd,
    },
    createElement(
      'div',
      { className: cn('relative px-4 py-3 sm:px-6', !compact && 'min-h-[50dvh]') },
      editor
        ? createElement(
            Prose,
            {
              measure: false,
              className: cn(
                compact ? 'document-editor-compact' : 'document-editor',
                'caret-primary selection:bg-primary/20',
              ),
              ...(dir ? { 'data-placeholder-dir': dir } : {}),
            },
            createElement(EditorContent, { editor }),
          )
        : null,
    ),
  );
}

export function editorAttributes({
  label,
  lang,
  dir,
  disabled,
  readOnly,
}: {
  label: string;
  lang?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  disabled: boolean;
  readOnly: boolean;
}): Record<string, string> {
  return {
    role: 'textbox',
    'aria-label': label,
    'aria-multiline': 'true',
    'aria-readonly': String(readOnly),
    'aria-disabled': String(disabled),
    spellcheck: 'true',
    ...(lang ? { lang } : {}),
    ...(dir ? { dir } : {}),
  };
}

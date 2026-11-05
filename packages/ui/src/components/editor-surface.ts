import {
  Extension,
  markInputRule,
  textblockTypeInputRule,
  wrappingInputRule,
  type Editor,
  type Extensions,
} from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import UniqueID from '@tiptap/extension-unique-id';
import type { DocumentProfile } from '@rezics/document';
import { identifiableNodeNames, textNodeNames, blocksNodeNames } from '@rezics/document';
import { Plugin } from '@tiptap/pm/state';
import { EditorContent } from '@tiptap/react';
import { createElement, type CompositionEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { safeDocumentUrl } from './document-url.ts';
import { documentExtensionsForProfile } from './document-extensions.ts';
import { Prose } from './prose.tsx';

function textLength(doc: Editor['state']['doc']): number {
  return Array.from(doc.textBetween(0, doc.content.size, '\n', ' ')).length;
}

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

    return rules;
  },
});

export function editorExtensions(
  profile: DocumentProfile,
  options: { placeholder?: string; maxLength?: number; readOnly?: boolean } = {},
): Extensions {
  const profileNodeNames = profile === 'text' ? textNodeNames : blocksNodeNames;
  const permittedNodes = new Set<string>(profileNodeNames);
  const uniqueTypes = [...identifiableNodeNames].filter((name) => permittedNodes.has(name));
  return [
    ...documentExtensionsForProfile(profile),
    Placeholder.configure({ placeholder: options.placeholder ?? '' }),
    UniqueID.configure({
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
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed
    .querySelectorAll('script,style,iframe,object,embed,svg,math,form,template,base,meta,link')
    .forEach((node) => node.remove());

  for (const element of parsed.body.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['style', 'srcdoc', 'formaction', 'action', 'srcset', 'xlink:href'].includes(name)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'href' && !safeDocumentUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'src' && !safeDocumentUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return parsed.body.innerHTML;
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
  onCompositionEnd,
}: EditorSurfaceProps): ReactNode {
  return createElement(
    'div',
    {
      className: cn('min-w-0 rounded-2xl border border-border/60 bg-background', disabled && 'opacity-64', className),
      'data-slot': 'rich-text-editor',
      onKeyDown,
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

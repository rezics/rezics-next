/// <reference path="./markdown-it-rule.d.ts" />
// SPDX-License-Identifier: Apache-2.0
import MarkdownIt from 'markdown-it';
import blockquote from 'markdown-it/lib/rules_block/blockquote.mjs';
import { Schema } from 'prosemirror-model';
import { defaultMarkdownParser, MarkdownParser } from 'prosemirror-markdown';
import { normalizeDocument, withDocumentIds } from './index.ts';
import {
  documentVersion,
  type DocumentMark,
  type DocumentNode,
  type DocumentProfile,
  type DocumentSnapshot,
  type JsonValue,
} from './types.ts';

const nodeNames: Record<string, string> = {
  bullet_list: 'bulletList',
  ordered_list: 'orderedList',
  list_item: 'listItem',
  code_block: 'codeBlock',
  horizontal_rule: 'horizontalRule',
  hard_break: 'hardBreak',
};
const markNames: Record<string, string> = { strong: 'bold', em: 'italic' };

const tokenizer = new MarkdownIt('commonmark', { html: false });
// Reddit's existing >!spoiler!< spelling starts like a CommonMark blockquote.
tokenizer.block.ruler.at(
  'blockquote',
  (state, start, end, silent) => {
    const position = state.bMarks[start] + state.tShift[start];
    if (
      state.src.startsWith('>!', position) &&
      state.src.slice(position, state.eMarks[start]).includes('!<')
    )
      return false;
    return blockquote(state, start, end, silent);
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);
tokenizer.inline.ruler.before('text', 'rezics_spoiler', (state, silent) => {
  if (!state.src.startsWith('>!', state.pos)) return false;
  const close = state.src.indexOf('!<', state.pos + 2);
  if (close < 0 || close + 2 > state.posMax || state.src.slice(state.pos, close).includes('\n'))
    return false;
  if (!silent) {
    state.push('spoiler_open', 'span', 1);
    const inner: typeof state.tokens = [];
    state.md.inline.parse(state.src.slice(state.pos + 2, close), state.md, state.env, inner);
    for (const token of inner) {
      const next = state.push(token.type, token.tag, token.nesting);
      next.content = token.content;
      next.attrs = token.attrs;
      next.children = token.children;
      next.markup = token.markup;
      next.info = token.info;
    }
    state.push('spoiler_close', 'span', -1);
  }
  state.pos = close + 2;
  return true;
});
const importSchema = new Schema({
  nodes: defaultMarkdownParser.schema.spec.nodes,
  marks: defaultMarkdownParser.schema.spec.marks.addToEnd('spoiler', {
    toDOM: () => ['span', { 'data-spoiler': 'true' }, 0],
  }),
});
const markdownParser = new MarkdownParser(importSchema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  spoiler: { mark: 'spoiler' },
});

/** CommonMark import uses the maintained ProseMirror parser. HTML remains literal text. */
export function fromMarkdown(
  markdown: string,
  profile: DocumentProfile = 'blocks',
): DocumentSnapshot {
  const source = markdownParser.parse(markdown).toJSON() as DocumentNode;
  const marks = (items: DocumentMark[] | undefined): DocumentMark[] | undefined =>
    items?.map((mark) => ({
      ...mark,
      type: markNames[mark.type] ?? mark.type,
    }));
  const convert = (node: DocumentNode): DocumentNode[] => {
    const type = nodeNames[node.type] ?? node.type;
    let attrs: Record<string, JsonValue> | undefined;
    if (type === 'orderedList') attrs = { start: node.attrs?.order ?? 1 };
    if (type === 'heading') attrs = { level: node.attrs?.level ?? 1 };
    if (type === 'codeBlock') attrs = { language: node.attrs?.params || null };
    if (type === 'image')
      attrs = {
        src: node.attrs?.src ?? '',
        alt: node.attrs?.alt ?? null,
        title: node.attrs?.title ?? null,
      };
    const translated: DocumentNode = {
      type,
      ...(attrs ? { attrs } : {}),
      ...(node.text !== undefined ? { text: node.text } : {}),
      ...(node.marks ? { marks: marks(node.marks) } : {}),
    };
    const children = node.content?.flatMap(convert);
    if (children) translated.content = children;
    // CommonMark images are inline; the Blocks profile gives each media object a stable block identity.
    if (
      (type === 'paragraph' || type === 'heading') &&
      children?.some((child) => child.type === 'image')
    ) {
      const result: DocumentNode[] = [];
      let chunk: DocumentNode[] = [];
      const flush = () => {
        if (chunk.length) result.push({ ...translated, content: chunk });
        chunk = [];
      };
      for (const child of children) {
        if (child.type === 'image') {
          flush();
          result.push(child);
        } else chunk.push(child);
      }
      flush();
      return result;
    }
    if (type === 'listItem' && translated.content?.[0]?.type !== 'paragraph') {
      translated.content = [{ type: 'paragraph' }, ...(translated.content ?? [])];
    }
    return [translated];
  };
  const doc = withDocumentIds(convert(source)[0]);
  return normalizeDocument({ version: documentVersion, profile, doc });
}

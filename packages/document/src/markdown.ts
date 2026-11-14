// SPDX-License-Identifier: Apache-2.0
import MarkdownIt from 'markdown-it';
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
// Obtain the built-in rule through the public parser API; package internals are not exported by markdown-it 15.
const quoteRules = new MarkdownIt.ParserBlock().ruler;
quoteRules.enableOnly('blockquote');
const blockquote = quoteRules.getRules('')[0]!;
// Reddit's existing >!spoiler!< spelling starts like a CommonMark blockquote.
tokenizer.block.ruler.at(
  'blockquote',
  (state, start, end, silent) => {
    const position = (state.bMarks[start] ?? 0) + (state.tShift[start] ?? 0);
    if (
      state.src.startsWith('>!', position) &&
      state.src.slice(position, state.eMarks[start] ?? position).includes('!<')
    )
      return false;
    return blockquote(state, start, end, silent);
  },
  { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
);
tokenizer.inline.ruler.before('text', 'rezics_footnote_reference', (state, silent) => {
  const match = /^\[\^([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\]/.exec(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) {
    const token = state.push('footnote_reference', '', 0);
    token.meta = match[1];
  }
  state.pos += match[0].length;
  return true;
});
tokenizer.inline.ruler.before('text', 'rezics_spoiler', (state, silent) => {
  if (!state.src.startsWith('>!', state.pos)) return false;
  const close = state.src.indexOf('!<', state.pos + 2);
  if (close < 0 || close + 2 > state.posMax || state.src.slice(state.pos, close).includes('\n')) return false;
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
      next.meta = token.meta;
    }
    state.push('spoiler_close', 'span', -1);
  }
  state.pos = close + 2;
  return true;
});

const importSchema = new Schema({
  nodes: defaultMarkdownParser.schema.spec.nodes.addToEnd('footnoteReference', {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { label: {} },
    toDOM: (node) => ['sup', { 'data-footnote-reference': node.attrs.label }, node.attrs.label],
  }),
  marks: defaultMarkdownParser.schema.spec.marks.addToEnd('spoiler', {
    toDOM: () => ['span', { 'data-spoiler': 'true' }, 0],
  }),
});
const markdownParser = new MarkdownParser(
  importSchema,
  tokenizer as unknown as ConstructorParameters<typeof MarkdownParser>[1],
  {
    ...defaultMarkdownParser.tokens,
    footnote_reference: {
      node: 'footnoteReference',
      getAttrs: (token) => ({ label: token.meta }),
    },
    spoiler: { mark: 'spoiler' },
  },
);

interface FootnoteDefinitionSource {
  label: string;
  body: string;
}

/** Remove top-level Markdown footnote definitions while retaining their source order and bodies. */
function extractFootnoteDefinitions(markdown: string): { body: string; definitions: FootnoteDefinitionSource[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  const definitions: FootnoteDefinitionSource[] = [];
  let fence: { character: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      body.push(line);
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`);
      if (closing.test(line)) fence = null;
      continue;
    }
    if (openingFence) {
      const marker = openingFence[1]!;
      fence = { character: marker[0]!, length: marker.length };
      body.push(line);
      continue;
    }

    const match = /^ {0,3}\[\^([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\]:[ \t]*(.*)$/.exec(line);
    if (!match) {
      body.push(line);
      continue;
    }

    const continuation = [match[2]!];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next]!;
      if (/^ {4}/.test(candidate)) {
        continuation.push(candidate.slice(4));
        next++;
        continue;
      }
      if (!candidate.trim() && /^ {4}/.test(lines[next + 1] ?? '')) {
        continuation.push('');
        next++;
        continue;
      }
      break;
    }
    definitions.push({ label: match[1]!, body: continuation.join('\n') });
    body.push('');
    index = next - 1;
  }
  return { body: body.join('\n'), definitions };
}

/** CommonMark import uses the maintained ProseMirror parser. HTML remains literal text. */
export function fromMarkdown(markdown: string, profile: DocumentProfile = 'blocks'): DocumentSnapshot {
  const extracted = extractFootnoteDefinitions(markdown);
  const source = markdownParser.parse(extracted.body).toJSON() as DocumentNode;
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
    if (type === 'footnoteReference') attrs = { label: node.attrs?.label ?? '' };
    if (type === 'image')
      attrs = {
        src: node.attrs?.src ?? '',
        alt: node.attrs?.alt ?? null,
        title: node.attrs?.title ?? null,
      };
    const convertedMarks = marks(node.marks);
    const translated: DocumentNode = {
      type,
      ...(attrs ? { attrs } : {}),
      ...(node.text !== undefined ? { text: node.text } : {}),
      ...(convertedMarks ? { marks: convertedMarks } : {}),
    };
    const children = node.content?.flatMap(convert);
    if (children) translated.content = children;
    // CommonMark images are inline; the Blocks profile gives each media object a stable block identity.
    if ((type === 'paragraph' || type === 'heading') && children?.some((child) => child.type === 'image')) {
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

  const root = convert(source)[0]!;
  const content = [...(root.content ?? [])];
  for (const definition of extracted.definitions) {
    const parsedBody = markdownParser.parse(definition.body).toJSON() as DocumentNode;
    const body = parsedBody.content?.flatMap(convert) ?? [];
    content.push({
      type: 'footnoteDefinition',
      attrs: { label: definition.label },
      content: body.length ? body : [{ type: 'paragraph' }],
    });
  }
  const doc = withDocumentIds({ type: 'doc', content });
  return normalizeDocument({ version: documentVersion, profile, doc });
}

import { Mark, Node, mergeAttributes, type Extensions } from '@tiptap/core';
import type { TagParseRule, ParseRule } from '@tiptap/pm/model';
import type { DocumentProfile } from '@rezics/document';
import { blocksNodeNames, markAttributes, textNodeNames } from '@rezics/document';
import { safeDocumentUrl } from './document-url.ts';
import {
  componentDOMAttributes,
  parseComponentAttributes,
  imageDOMAttributes,
  parseImageAttributes,
  mediaDOMAttributes,
  parseMediaAttributes,
} from './document-component-data.ts';
import {
  parseFormattingData,
  parseCodeLanguage,
  safeAlignment,
  safeHeadingLevel,
  textStyleCSS,
  textEmphasisCSS,
} from './document-style.ts';

type Attribute = Record<string, unknown>;

const common = {
  id: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute('data-block-id'),
    renderHTML: (attributes: Attribute) => (attributes.id ? { 'data-block-id': attributes.id as string } : {}),
  },
  lang: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const lang = element.getAttribute('lang');
      return lang && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
    },
  },
  dir: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const dir = element.getAttribute('dir');
      return dir && ['ltr', 'rtl', 'auto'].includes(dir) ? dir : null;
    },
  },
};

const commonAttrs = (element: HTMLElement) => ({
  id: (() => {
    const id = element.getAttribute('data-block-id');
    return id && id.length <= 256 ? id : null;
  })(),
  lang: (() => {
    const lang = element.getAttribute('lang');
    return lang && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
  })(),
  dir: (() => {
    const dir = element.getAttribute('dir');
    return dir && ['ltr', 'rtl', 'auto'].includes(dir) ? dir : null;
  })(),
});

const toPositiveNumber = (value: string | null): number | null => {
  const parsed = value ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const tags = (tag: string): TagParseRule[] => [{ tag }];

const block = (name: string, tag: string, extra: Attribute = {}, parseHTML: TagParseRule[] = tags(tag)) => {
  const nestedOnly = ['listItem', 'taskItem', 'tableRow', 'tableCell', 'tableHeader'].includes(name);
  const content =
    name === 'horizontalRule' || name === 'image' || name === 'media' || name === 'extensionBlock'
      ? undefined
      : name === 'table'
        ? 'tableRow+'
        : name === 'tableRow'
          ? '(tableCell | tableHeader)*'
          : name === 'tableCell' || name === 'tableHeader'
            ? 'block+'
            : name === 'listItem' || name === 'taskItem'
              ? 'paragraph block*'
              : name === 'bulletList' || name === 'orderedList'
                ? 'listItem+'
                : name === 'taskList'
                  ? 'taskItem+'
                  : name === 'blockquote'
                    ? 'block+'
                    : name === 'codeBlock'
                      ? 'text*'
                      : 'inline*';
  const isLeaf = ['horizontalRule', 'image', 'media', 'extensionBlock'].includes(name);
  const isDraggable = !nestedOnly;

  return Node.create({
    name,
    ...(nestedOnly ? {} : { group: 'block' }),
    content,
    ...(name === 'heading' ? { defining: true } : {}),
    ...(name === 'codeBlock' ? { marks: '' } : {}),
    atom: isLeaf,
    draggable: isDraggable,
    ...(isLeaf
      ? {
          renderText: ({ node }: { node: import('@tiptap/pm/model').Node }) =>
            String(
              name === 'image'
                ? (node.attrs.alt ?? '')
                : name === 'media'
                  ? (node.attrs.caption ?? '')
                  : (node.attrs.fallback ?? ''),
            ),
        }
      : {}),
    addAttributes: () => ({ ...common, ...extra }),
    parseHTML: () => parseHTML.map((rule) => ({ ...rule, preserveWhitespace: 'full' })),
    renderHTML: ({ node, HTMLAttributes }) => {
      const outputTag = name === 'heading' ? `h${safeHeadingLevel(node.attrs.level)}` : tag;
      const attributes = {
        ...HTMLAttributes,
        ...(isDraggable ? { draggable: 'true' } : {}),
        ...(['taskList', 'taskItem'].includes(name) ? { 'data-type': name } : {}),
        ...(['paragraph', 'heading'].includes(name) && safeAlignment(node.attrs.textAlign)
          ? { style: `text-align:${safeAlignment(node.attrs.textAlign)}` }
          : {}),
      };
      if (name === 'table') return ['table', attributes, ['tbody', 0]];
      if (name === 'codeBlock')
        return [
          'pre',
          attributes,
          [
            'code',
            node.attrs.language != null
              ? {
                  'data-language': node.attrs.language,
                  'data-document-code-language': JSON.stringify(node.attrs.language),
                }
              : {},
            0,
          ],
        ];
      if (name === 'image')
        return [
          'figure',
          { ...commonRendered(attributes), ...imageDOMAttributes(node.attrs) },
          ['span', {}, node.attrs.alt || 'Image'],
        ];
      if (name === 'media')
        return [
          'figure',
          { ...commonRendered(attributes), ...mediaDOMAttributes(node.attrs) },
          ['figcaption', {}, node.attrs.caption || 'Media unavailable'],
        ];
      if (name === 'extensionBlock')
        return [
          'div',
          { ...commonRendered(attributes), ...componentDOMAttributes(node.attrs) },
          node.attrs.fallback || 'Embedded component unavailable',
        ];
      return isLeaf ? [outputTag, attributes] : [outputTag, attributes, 0];
    },
  });
};

function commonRendered(attributes: Attribute): Attribute {
  return Object.fromEntries(
    Object.entries(attributes).filter(([name]) =>
      ['data-block-id', 'data-id', 'lang', 'dir', 'draggable'].includes(name),
    ),
  );
}

const Doc = Node.create({ name: 'doc', topNode: true, content: '(block | footnoteDefinition)+' });
const Text = Node.create({ name: 'text', group: 'inline' });
const HardBreak = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  atom: true,
  parseHTML: () => tags('br'),
  renderHTML: () => ['br'],
});

const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({
    accountId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-mention-account-id'),
      renderHTML: (attrs: Attribute) => ({ 'data-mention-account-id': attrs.accountId }),
    },
  }),
  parseHTML: () => [
    {
      tag: 'span[data-mention-account-id]',
      getAttrs: (element) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          element.getAttribute('data-mention-account-id') ?? '',
        )
          ? {}
          : false,
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, '@'],
  renderText: () => '@',
});

const Ruby = Node.create({
  name: 'ruby',
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '_',
  isolating: true,
  addAttributes: () => ({
    rt: { default: '', parseHTML: (element: HTMLElement) => element.querySelector('rt')?.textContent ?? '' },
    position: {
      default: 'over',
      parseHTML: (element: HTMLElement) =>
        element.getAttribute('data-ruby-position') || element.style.rubyPosition || 'over',
      renderHTML: () => ({}),
    },
    lang: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute('lang') },
  }),
  parseHTML: () => [
    {
      tag: 'ruby',
      contentElement: 'span[data-ruby-base]',
      getAttrs: (element) => {
        const position =
          (element as HTMLElement).getAttribute('data-ruby-position') ||
          (element as HTMLElement).style.rubyPosition ||
          'over';
        const lang = (element as HTMLElement).getAttribute('lang');
        const safeLang = lang && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
        return ['over', 'under', 'inter-character'].includes(position) ? { lang: safeLang } : false;
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'ruby',
    mergeAttributes(HTMLAttributes, {
      'data-ruby-position': node.attrs.position,
      style: ['over', 'under', 'inter-character'].includes(node.attrs.position)
        ? `ruby-position:${node.attrs.position}`
        : '',
    }),
    ['span', { 'data-ruby-base': '' }, 0],
    ['rp', {}, '('],
    ['rt', {}, node.attrs.rt],
    ['rp', {}, ')'],
  ],
});

const InlineExtension = Node.create({
  name: 'extensionInline',
  group: 'inline',
  inline: true,
  atom: true,
  renderText: ({ node }) => String(node.attrs.fallback ?? ''),
  addAttributes: () => ({
    id: { default: null, rendered: false, parseHTML: () => null },
    definition: { default: '', rendered: false, parseHTML: () => null },
    version: { default: '1', rendered: false, parseHTML: () => null },
    payload: { default: null, rendered: false, parseHTML: () => null },
    fallback: { default: '', rendered: false, parseHTML: () => null },
  }),
  parseHTML: () => [
    {
      tag: 'span[data-document-component]',
      getAttrs: (element) => parseComponentAttributes(element as HTMLElement),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, componentDOMAttributes(node.attrs)),
    node.attrs.fallback,
  ],
});

const footnoteLabel = (value: string | null): value is string =>
  value !== null && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ label: { default: '' } }),
  parseHTML: () => [
    {
      tag: 'sup[data-footnote-reference]',
      getAttrs: (element) => {
        const label = (element as HTMLElement).getAttribute('data-footnote-reference');
        return footnoteLabel(label) ? { label } : false;
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'sup',
    mergeAttributes(HTMLAttributes, { 'data-footnote-reference': node.attrs.label }),
    `[^${node.attrs.label}]`,
  ],
  renderText: ({ node }) => `[^${node.attrs.label}]`,
});

const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'footnoteDefinition',
  content: 'block+',
  defining: true,
  draggable: true,
  addAttributes: () => ({
    ...common,
    label: {
      default: '',
      parseHTML: (element: HTMLElement) => element.getAttribute('data-footnote-definition'),
    },
  }),
  parseHTML: () => [
    {
      tag: 'aside[data-footnote-definition]',
      getAttrs: (element) => {
        const label = (element as HTMLElement).getAttribute('data-footnote-definition');
        return footnoteLabel(label) ? {} : false;
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'aside',
    mergeAttributes(HTMLAttributes, { 'data-footnote-definition': node.attrs.label, draggable: 'true' }),
    0,
  ],
});

const mark = (name: string, tag: string, parse: ParseRule[] = tags(tag)) =>
  Mark.create({
    name,
    parseHTML: () => parse,
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
  });

const Link = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes: () => ({
    href: { default: '' },
    target: { default: null },
    rel: { default: null },
    class: { default: null },
    title: { default: null },
  }),
  parseHTML: () => [
    {
      tag: 'a[href]',
      getAttrs: (element) => {
        const anchor = element as HTMLAnchorElement;
        const href = safeDocumentUrl(anchor.getAttribute('href'));
        return href
          ? {
              href,
              target: anchor.getAttribute('target'),
              rel: anchor.getAttribute('rel'),
              class: anchor.getAttribute('class'),
              title: anchor.getAttribute('title'),
            }
          : false;
      },
    },
  ],
  renderHTML: ({ HTMLAttributes }) => ['a', HTMLAttributes, 0],
});

const TextStyle = Mark.create({
  name: 'textStyle',
  addAttributes: () => ({
    color: { default: null },
    backgroundColor: { default: null },
  }),
  parseHTML: () => [
    {
      tag: '[data-document-text-style], [style]',
      priority: 70,
      consuming: false,
      getAttrs: (element) => {
        const node = element as HTMLElement;
        const own = parseFormattingData(node, 'text-style');
        if (own !== undefined) return own;
        const color = node.style.getPropertyValue('color'),
          backgroundColor = node.style.getPropertyValue('background-color');
        return color || backgroundColor ? { color: color || null, backgroundColor: backgroundColor || null } : false;
      },
    },
  ],
  renderHTML: ({ mark: current }) => [
    'span',
    {
      'data-document-text-style': JSON.stringify(current.attrs),
      style: textStyleCSS(current.attrs),
    },
    0,
  ],
});

const TextEmphasis = Mark.create({
  name: 'textEmphasis',
  addAttributes: () => ({
    shape: { default: 'dot' },
    fill: { default: 'filled' },
    color: { default: null },
    position: { default: 'over' },
  }),
  parseHTML: () => [
    {
      tag: '[data-document-text-emphasis], span[data-text-emphasis], [style]',
      priority: 71,
      consuming: false,
      getAttrs: (element) => {
        const span = element as HTMLElement;
        const own = parseFormattingData(span, 'text-emphasis');
        if (own !== undefined) return own;
        const shape =
          span.dataset.textEmphasis ??
          span.style.textEmphasisStyle
            .split(' ')
            .find((value) => ['dot', 'sesame', 'circle', 'double-circle', 'triangle'].includes(value));
        const fill = span.style.textEmphasisStyle.includes('open') ? 'open' : 'filled';
        const position = span.style.textEmphasisPosition.includes('under') ? 'under' : 'over';
        return ['dot', 'sesame', 'circle', 'double-circle', 'triangle'].includes(shape ?? '')
          ? { shape, fill, color: span.style.textEmphasisColor || null, position }
          : false;
      },
    },
  ],
  renderHTML: ({ mark: current }) => [
    'span',
    {
      'data-text-emphasis': current.attrs.shape,
      'data-document-text-emphasis': JSON.stringify(current.attrs),
      style: textEmphasisCSS(current.attrs),
    },
    0,
  ],
});

const paragraph = block('paragraph', 'p', { textAlign: { default: null, rendered: false } }, [
  {
    tag: 'p',
    getAttrs: (element) => ({
      ...commonAttrs(element as HTMLElement),
      textAlign: safeAlignment((element as HTMLElement).style.textAlign) ?? null,
    }),
  },
]);

const heading = block(
  'heading',
  'h1',
  {
    level: { default: 1, rendered: false },
    textAlign: { default: null, rendered: false },
  },
  Array.from({ length: 6 }, (_, index) => ({
    tag: `h${index + 1}`,
    getAttrs: (element) => ({
      ...commonAttrs(element as HTMLElement),
      level: index + 1,
      textAlign: safeAlignment((element as HTMLElement).style.textAlign) ?? null,
    }),
  })),
);

const blockquote = block('blockquote', 'blockquote', {}, [
  { tag: 'blockquote', getAttrs: (element) => commonAttrs(element as HTMLElement) },
]);
const bulletList = block('bulletList', 'ul', {}, [
  {
    tag: 'ul:not([data-type="taskList"])',
    getAttrs: (element) => commonAttrs(element as HTMLElement),
  },
]);
const orderedList = block(
  'orderedList',
  'ol',
  {
    start: {
      default: 1,
      parseHTML: (element: HTMLElement) => toPositiveNumber(element.getAttribute('start')) ?? 1,
      renderHTML: (attributes: Attribute) => (attributes.start === 1 ? {} : { start: attributes.start }),
    },
  },
  [{ tag: 'ol', getAttrs: (element) => commonAttrs(element as HTMLElement) }],
);
const listItem = block('listItem', 'li', {}, [
  {
    tag: 'li:not([data-type="taskItem"])',
    getAttrs: (element) => commonAttrs(element as HTMLElement),
  },
]);
const taskList = block('taskList', 'ul', {}, [
  { tag: 'ul[data-type="taskList"]', getAttrs: (element) => commonAttrs(element as HTMLElement) },
]);
const taskItem = block(
  'taskItem',
  'li',
  {
    checked: {
      default: false,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-checked') === 'true',
      renderHTML: (attributes: Attribute) => ({ 'data-checked': String(Boolean(attributes.checked)) }),
    },
  },
  [{ tag: 'li[data-type="taskItem"]', getAttrs: (element) => commonAttrs(element as HTMLElement) }],
);
const codeBlock = block('codeBlock', 'pre', { language: { default: null, rendered: false, parseHTML: () => null } }, [
  {
    tag: 'pre',
    getAttrs: (element) => {
      const pre = element as HTMLElement;
      const code = pre.querySelector('code');
      const language = code ? parseCodeLanguage(code) : undefined;
      if (language === false) return false;
      return {
        ...commonAttrs(pre),
        language: language === undefined ? (code?.getAttribute('data-language') ?? null) : language,
      };
    },
  },
]);
const horizontalRule = block('horizontalRule', 'hr');
const table = block('table', 'table');
const tableRow = block('tableRow', 'tr');
const cellAttrs = {
  colspan: {
    default: 1,
    parseHTML: (element: HTMLElement) => toPositiveNumber(element.getAttribute('colspan')) ?? 1,
    renderHTML: (attributes: Attribute) => (attributes.colspan === 1 ? {} : { colspan: attributes.colspan }),
  },
  rowspan: {
    default: 1,
    parseHTML: (element: HTMLElement) => toPositiveNumber(element.getAttribute('rowspan')) ?? 1,
    renderHTML: (attributes: Attribute) => (attributes.rowspan === 1 ? {} : { rowspan: attributes.rowspan }),
  },
  colwidth: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const widths = (element.getAttribute('data-colwidth') ?? element.getAttribute('colwidth'))
        ?.split(',')
        .map(Number);
      return widths?.length === (toPositiveNumber(element.getAttribute('colspan')) ?? 1) &&
        widths.every((width) => Number.isSafeInteger(width) && width > 0)
        ? widths
        : null;
    },
    renderHTML: (attributes: Attribute) =>
      attributes.colwidth ? { 'data-colwidth': (attributes.colwidth as number[]).join(',') } : {},
  },
  align: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      return (
        safeAlignment(element.style.textAlign) ??
        safeAlignment(element.getAttribute('align')?.trim().toLowerCase()) ??
        null
      );
    },
    renderHTML: (attributes: Attribute) =>
      safeAlignment(attributes.align)
        ? { align: attributes.align, style: `text-align:${safeAlignment(attributes.align)}` }
        : {},
  },
};
const tableCell = block('tableCell', 'td', cellAttrs);
const tableHeader = block('tableHeader', 'th', cellAttrs);
const image = block(
  'image',
  'img',
  {
    src: {
      default: '',
      parseHTML: (element: HTMLElement) =>
        element.hasAttribute('data-document-image') ? null : element.getAttribute('src'),
    },
    variant: { default: 'original', rendered: false },
    alt: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.hasAttribute('data-document-image') ? null : element.getAttribute('alt'),
    },
    title: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.hasAttribute('data-document-image') ? null : element.getAttribute('title'),
    },
    width: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.hasAttribute('data-document-image') ? null : toPositiveNumber(element.getAttribute('width')),
      renderHTML: (attributes: Attribute) => (attributes.width ? { width: attributes.width } : {}),
    },
    height: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.hasAttribute('data-document-image') ? null : toPositiveNumber(element.getAttribute('height')),
      renderHTML: (attributes: Attribute) => (attributes.height ? { height: attributes.height } : {}),
    },
    conceal: {
      default: false,
      parseHTML: (element: HTMLElement) =>
        element.hasAttribute('data-document-image') ? null : element.getAttribute('data-conceal') === 'true',
      renderHTML: (attributes: Attribute) => (attributes.conceal ? { 'data-conceal': 'true' } : {}),
    },
  },
  [
    { tag: 'figure[data-document-image]', getAttrs: (element) => parseImageAttributes(element as HTMLElement) },
    {
      tag: 'img[src]',
      getAttrs: (element) => {
        const imageElement = element as HTMLImageElement;
        const src = imageElement.getAttribute('src') ?? '';
        return src
          ? {
              ...commonAttrs(imageElement),
              src,
              alt: imageElement.getAttribute('alt'),
              title: imageElement.getAttribute('title'),
            }
          : false;
      },
    },
  ],
);
const media = block(
  'media',
  'figure',
  {
    src: { default: '', parseHTML: () => null },
    kind: { default: 'file', parseHTML: () => null },
    caption: { default: '', parseHTML: () => null },
  },
  [
    { tag: 'figure[data-document-media]', getAttrs: (element) => parseMediaAttributes(element as HTMLElement) },
    {
      tag: 'figure[data-media]',
      getAttrs: (element) => {
        const figure = element as HTMLElement;
        const kind = figure.dataset.media;
        const src = figure.querySelector('a')?.getAttribute('href') ?? '';
        return ['audio', 'video', 'file'].includes(kind ?? '') && src
          ? {
              ...commonAttrs(figure),
              src,
              kind,
              caption: figure.querySelector('figcaption')?.textContent ?? '',
            }
          : false;
      },
    },
  ],
);
const extensionBlock = block(
  'extensionBlock',
  'div',
  {
    definition: { default: '', rendered: false, parseHTML: () => null },
    version: { default: '1', rendered: false, parseHTML: () => null },
    payload: { default: null, rendered: false, parseHTML: () => null },
    fallback: { default: '', rendered: false, parseHTML: () => null },
  },
  [
    {
      tag: 'div[data-document-component]',
      getAttrs: (element) => {
        const component = parseComponentAttributes(element as HTMLElement);
        return component ? { ...commonAttrs(element as HTMLElement), ...component } : false;
      },
    },
  ],
);

/** The shared schema for text and blocks documents. Attributes match the document wire schemas. */
export const documentExtensions: Extensions = [
  Doc,
  Text,
  paragraph,
  heading,
  blockquote,
  bulletList,
  orderedList,
  listItem,
  taskList,
  taskItem,
  codeBlock,
  horizontalRule,
  HardBreak,
  Mention,
  Ruby,
  table,
  tableRow,
  tableCell,
  tableHeader,
  image,
  media,
  extensionBlock,
  InlineExtension,
  FootnoteDefinition,
  FootnoteReference,
  mark('bold', 'strong', [
    { tag: 'strong' },
    { tag: 'b' },
    { style: 'font-weight', getAttrs: (value) => (/^(?:bold|bolder|[6-9]00)$/.test(value) ? {} : false) },
  ]),
  mark('italic', 'em', [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }]),
  mark('underline', 'u', [
    { tag: 'u' },
    { style: 'text-decoration-line', getAttrs: (value) => (value.includes('underline') ? {} : false) },
  ]),
  mark('strike', 's', [
    { tag: 's' },
    { tag: 'del' },
    { style: 'text-decoration-line', getAttrs: (value) => (value.includes('line-through') ? {} : false) },
  ]),
  mark('code', 'code'),
  Mark.create({
    name: 'spoiler',
    parseHTML: () => [{ tag: 'span[data-spoiler]' }],
    renderHTML: () => ['span', { 'data-spoiler': '', class: 'document-spoiler-authored' }, 0],
  }),
  Link,
  TextStyle,
  TextEmphasis,
  Mark.create({
    name: 'language',
    addAttributes: () => ({
      lang: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const lang = element.getAttribute('lang');
          return lang && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
        },
      },
      dir: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const dir = element.getAttribute('dir');
          return dir && ['ltr', 'rtl', 'auto'].includes(dir) ? dir : null;
        },
      },
    }),
    parseHTML: () => [{ tag: 'span[lang]' }, { tag: 'span[dir]' }],
    renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
  }),
];

/** Select only the node names admitted by a document profile. */
export function documentExtensionsForProfile(profile: DocumentProfile): Extensions {
  const names = profile === 'text' ? textNodeNames : blocksNodeNames;
  const allowed = new Set<string>(['doc', ...names, ...Object.keys(markAttributes)]);
  return documentExtensions.filter((extension) => allowed.has(extension.name));
}

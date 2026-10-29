import { Mark, Node, mergeAttributes, type Extensions } from '@tiptap/core';
import type { TagParseRule } from '@tiptap/pm/model';
import type { DocumentProfile } from '@rezics/document';
import { blocksNodeNames, markAttributes, textNodeNames } from '@rezics/document';
import { safeDocumentUrl } from './document-url.ts';

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
          ? '(tableCell | tableHeader)+'
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

  return Node.create({
    name,
    ...(nestedOnly ? {} : { group: 'block' }),
    content,
    atom: isLeaf,
    addAttributes: () => ({ ...common, ...extra }),
    parseHTML: () => parseHTML,
    renderHTML: ({ node, HTMLAttributes }) => {
      const outputTag = name === 'heading' ? `h${node.attrs.level}` : tag;
      if (name === 'table') return ['table', HTMLAttributes, ['tbody', 0]];
      return isLeaf ? [outputTag, HTMLAttributes] : [outputTag, HTMLAttributes, 0];
    },
  });
};

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' });
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
      parseHTML: (element: HTMLElement) => element.style.rubyPosition || 'over',
      renderHTML: () => ({}),
    },
    lang: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute('lang') },
  }),
  parseHTML: () => [
    {
      tag: 'ruby',
      contentElement: 'span[data-ruby-base]',
      getAttrs: (element) => {
        const position = (element as HTMLElement).style.rubyPosition || 'over';
        const lang = (element as HTMLElement).getAttribute('lang');
        const safeLang = lang && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
        return ['over', 'under', 'inter-character'].includes(position) ? { lang: safeLang } : false;
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'ruby',
    mergeAttributes(HTMLAttributes, { style: `ruby-position: ${node.attrs.position}` }),
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
  addAttributes: () => ({
    id: { default: null },
    definition: { default: '' },
    version: { default: '1' },
    payload: { default: null },
    fallback: { default: '' },
  }),
  parseHTML: () => [
    {
      tag: 'span[data-document-component]',
      getAttrs: (element) => {
        const definition = (element as HTMLElement).getAttribute('data-document-component') ?? '';
        return definition ? { definition, version: '1', payload: null, fallback: element.textContent ?? '' } : false;
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-document-component': node.attrs.definition }),
    node.attrs.fallback,
  ],
});

const mark = (name: string, tag: string, parse = tags(tag)) =>
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
  parseHTML: () => [],
  renderHTML: ({ mark: current }) => [
    'span',
    {
      style: [
        current.attrs.color && `color:${current.attrs.color}`,
        current.attrs.backgroundColor && `background-color:${current.attrs.backgroundColor}`,
      ]
        .filter(Boolean)
        .join(';'),
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
      tag: 'span[data-text-emphasis]',
      getAttrs: (element) => {
        const span = element as HTMLElement;
        const shape = span.dataset.textEmphasis;
        const fill = span.style.textEmphasisStyle.includes('open') ? 'open' : 'filled';
        const position = span.style.textEmphasisPosition.includes('under') ? 'under' : 'over';
        return ['dot', 'sesame', 'circle', 'double-circle', 'triangle'].includes(shape ?? '')
          ? { shape, fill, color: null, position }
          : false;
      },
    },
  ],
  renderHTML: ({ mark: current }) => [
    'span',
    {
      'data-text-emphasis': current.attrs.shape,
      style: `text-emphasis-style:${current.attrs.fill} ${current.attrs.shape};text-emphasis-position:${current.attrs.position};${current.attrs.color ? `text-emphasis-color:${current.attrs.color}` : ''}`,
    },
    0,
  ],
});

const paragraph = block('paragraph', 'p', { textAlign: { default: null, rendered: false } }, [
  {
    tag: 'p',
    getAttrs: (element) => commonAttrs(element as HTMLElement),
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
    getAttrs: (element) => ({ ...commonAttrs(element as HTMLElement), level: index + 1 }),
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
const codeBlock = block('codeBlock', 'pre', { language: { default: null, rendered: false } }, [
  {
    tag: 'pre',
    getAttrs: (element) => {
      const pre = element as HTMLElement;
      return {
        ...commonAttrs(pre),
        language: pre.querySelector('code')?.getAttribute('data-language') ?? null,
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
  colwidth: { default: null, rendered: false },
  align: { default: null, rendered: false },
};
const tableCell = block('tableCell', 'td', cellAttrs);
const tableHeader = block('tableHeader', 'th', cellAttrs);
const image = block(
  'image',
  'img',
  {
    src: { default: '' },
    variant: { default: 'original', rendered: false },
    alt: { default: null },
    title: { default: null },
    width: {
      default: null,
      parseHTML: (element: HTMLElement) => toPositiveNumber(element.getAttribute('width')),
      renderHTML: (attributes: Attribute) => (attributes.width ? { width: attributes.width } : {}),
    },
    height: {
      default: null,
      parseHTML: (element: HTMLElement) => toPositiveNumber(element.getAttribute('height')),
      renderHTML: (attributes: Attribute) => (attributes.height ? { height: attributes.height } : {}),
    },
    conceal: {
      default: false,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-conceal') === 'true',
      renderHTML: (attributes: Attribute) => (attributes.conceal ? { 'data-conceal': 'true' } : {}),
    },
  },
  [
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
    src: { default: '' },
    kind: { default: 'file' },
    caption: { default: '' },
  },
  [
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
    definition: { default: '' },
    version: { default: '1' },
    payload: { default: null },
    fallback: { default: '' },
  },
  [
    {
      tag: 'div[data-document-component]',
      getAttrs: (element) => {
        const blockElement = element as HTMLElement;
        const definition = blockElement.getAttribute('data-document-component') ?? '';
        return definition
          ? {
              ...commonAttrs(blockElement),
              definition,
              version: '1',
              payload: null,
              fallback: element.textContent ?? '',
            }
          : false;
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
  mark('bold', 'strong'),
  mark('italic', 'em'),
  mark('underline', 'u'),
  mark('strike', 's'),
  mark('code', 'code'),
  mark('spoiler', 'span', [{ tag: 'span[data-spoiler]' }]),
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

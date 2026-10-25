import { Mark, Node } from '@tiptap/core';
const attrs = { id: { default: null }, lang: { default: null }, dir: { default: null } };
const block = (name: string, tag: string, extra: Record<string, unknown> = {}) =>
  Node.create({
    name,
    group: 'block',
    content:
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
                    : name === 'codeBlock'
                      ? 'text*'
                      : 'inline*',
    atom: ['horizontalRule', 'image', 'media', 'extensionBlock'].includes(name),
    addAttributes: () => ({ ...attrs, ...extra }),
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
  });

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' });
const Text = Node.create({ name: 'text', group: 'inline' });
const HardBreak = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  atom: true,
  renderHTML: () => ['br'],
});
const Ruby = Node.create({
  name: 'ruby',
  group: 'inline',
  inline: true,
  content: 'text*',
  addAttributes: () => ({ rt: { default: '' }, position: { default: 'over' }, lang: { default: null } }),
  renderHTML: ({ node }) => [
    'ruby',
    { lang: node.attrs.lang, style: `ruby-position: ${node.attrs.position}` },
    ['span', 0],
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
  renderHTML: ({ node }) => ['span', { 'data-document-component': node.attrs.definition }, node.attrs.fallback],
});

const mark = (name: string, tag: string, attributes: Record<string, unknown> = {}) =>
  Mark.create({ name, addAttributes: () => attributes, renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0] });
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
  renderHTML: ({ HTMLAttributes }) => ['a', HTMLAttributes, 0],
});
const TextStyle = Mark.create({
  name: 'textStyle',
  addAttributes: () => ({ color: { default: null }, backgroundColor: { default: null } }),
  renderHTML: ({ mark }) => [
    'span',
    {
      style: [
        mark.attrs.color && `color:${mark.attrs.color}`,
        mark.attrs.backgroundColor && `background-color:${mark.attrs.backgroundColor}`,
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
  renderHTML: ({ mark }) => [
    'span',
    {
      style: `text-emphasis-style:${mark.attrs.fill} ${mark.attrs.shape};text-emphasis-position:${mark.attrs.position};${mark.attrs.color ? `text-emphasis-color:${mark.attrs.color}` : ''}`,
    },
    0,
  ],
});

/** The shared schema for text and blocks documents. */
export const documentExtensions = [
  Doc,
  Text,
  block('paragraph', 'p', { textAlign: { default: null } }),
  block('heading', 'h2', { level: { default: 1 }, textAlign: { default: null } }),
  block('blockquote', 'blockquote'),
  block('bulletList', 'ul'),
  block('orderedList', 'ol', { start: { default: 1 } }),
  block('listItem', 'li'),
  block('taskList', 'ul'),
  block('taskItem', 'li', { checked: { default: false } }),
  block('codeBlock', 'pre', { language: { default: null } }),
  block('horizontalRule', 'hr'),
  HardBreak,
  Ruby,
  block('table', 'table'),
  block('tableRow', 'tr'),
  block('tableCell', 'td', {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
    align: { default: null },
  }),
  block('tableHeader', 'th', {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
    align: { default: null },
  }),
  block('image', 'img', {
    src: { default: '' },
    alt: { default: '' },
    title: { default: null },
    width: { default: null },
    height: { default: null },
    variant: { default: 'original' },
    conceal: { default: false },
  }),
  block('media', 'figure', { src: { default: '' }, kind: { default: 'file' }, caption: { default: '' } }),
  block('extensionBlock', 'div', {
    definition: { default: '' },
    version: { default: '1' },
    payload: { default: null },
    fallback: { default: '' },
  }),
  InlineExtension,
  mark('bold', 'strong'),
  mark('italic', 'em'),
  mark('underline', 'u'),
  mark('strike', 's'),
  mark('code', 'code'),
  mark('spoiler', 'span'),
  Link,
  TextStyle,
  TextEmphasis,
  mark('language', 'span', { lang: { default: null }, dir: { default: null } }),
];

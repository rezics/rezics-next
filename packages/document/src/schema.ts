// SPDX-License-Identifier: Apache-2.0
import Type, { type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Schema, type NodeSpec, type MarkSpec, type DOMOutputSpec } from 'prosemirror-model';
import { nodes as basicNodes, marks as basicMarks } from 'prosemirror-schema-basic';
import { bulletList, orderedList, listItem } from 'prosemirror-schema-list';
import { tableNodes } from 'prosemirror-tables';
import { documentVersion, type DocumentProfile } from './types.ts';

const closed = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 256 });
const optionalString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
// CSS Color syntax remains browser-defined; delimiters cannot escape a single declaration.
const color = Type.Optional(
  Type.Union([Type.String({ pattern: '^[^;{}\\u0000-\\u001f]*$' }), Type.Null()]),
);
const dimension = Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]));
const language = Type.Optional(
  Type.Union([
    Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$' }),
    Type.Null(),
  ]),
);
const choice = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const direction = Type.Optional(Type.Union([choice(['ltr', 'rtl', 'auto']), Type.Null()]));
const common = { id, lang: language, dir: direction };
const align = Type.Optional(
  Type.Union([choice(['left', 'right', 'center', 'justify']), Type.Null()]),
);
const commonAttrs = { id: { default: null }, lang: { default: null }, dir: { default: null } };

/** Attributes are shared by wire validation and the reference ProseMirror schema. */
export const nodeAttributes: Record<string, Record<string, TSchema>> = {
  paragraph: { ...common, textAlign: align },
  heading: {
    ...common,
    level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
    textAlign: align,
  },
  blockquote: common,
  bulletList: common,
  orderedList: { ...common, start: Type.Optional(Type.Integer({ minimum: 1 })) },
  listItem: common,
  taskList: common,
  taskItem: { ...common, checked: Type.Optional(Type.Boolean()) },
  codeBlock: { ...common, language: optionalString },
  horizontalRule: common,
  ruby: {
    rt: Type.String(),
    position: Type.Optional(choice(['over', 'under', 'inter-character'])),
    lang: language,
  },
  table: common,
  tableRow: common,
  tableCell: {
    ...common,
    align,
    colspan: Type.Optional(Type.Integer({ minimum: 1 })),
    rowspan: Type.Optional(Type.Integer({ minimum: 1 })),
    colwidth: Type.Optional(Type.Union([Type.Array(Type.Integer({ minimum: 1 })), Type.Null()])),
  },
  tableHeader: {
    ...common,
    align,
    colspan: Type.Optional(Type.Integer({ minimum: 1 })),
    rowspan: Type.Optional(Type.Integer({ minimum: 1 })),
    colwidth: Type.Optional(Type.Union([Type.Array(Type.Integer({ minimum: 1 })), Type.Null()])),
  },
  image: {
    ...common,
    src: Type.String({ minLength: 1 }),
    alt: optionalString,
    title: optionalString,
    width: dimension,
    height: dimension,
  },
  media: {
    ...common,
    src: Type.String({ minLength: 1 }),
    kind: choice(['audio', 'video', 'file']),
    caption: Type.Optional(Type.String()),
  },
  extensionBlock: {
    ...common,
    definition: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    payload: Type.Unknown(),
    fallback: Type.String(),
  },
  extensionInline: {
    id,
    definition: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    payload: Type.Unknown(),
    fallback: Type.String(),
  },
};

export const markAttributes: Record<string, Record<string, TSchema>> = {
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  code: {},
  spoiler: {},
  link: {
    href: Type.String({ minLength: 1 }),
    target: optionalString,
    rel: optionalString,
    class: optionalString,
    title: optionalString,
  },
  textStyle: { color, backgroundColor: color },
  textEmphasis: {
    shape: Type.Optional(choice(['dot', 'sesame', 'circle', 'double-circle', 'triangle'])),
    fill: Type.Optional(choice(['filled', 'open'])),
    color,
    position: Type.Optional(choice(['over', 'under'])),
  },
  language: { lang: language, dir: direction },
};

export const textNodeNames = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'ruby',
  'text',
] as const;
export const blocksNodeNames = [
  ...textNodeNames,
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'image',
  'media',
  'extensionBlock',
  'extensionInline',
] as const;
export const identifiableNodeNames: ReadonlySet<string> = new Set(
  Object.entries(nodeAttributes)
    .filter(([, attrs]) => 'id' in attrs)
    .map(([name]) => name),
);

function domAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  if (attrs.id) result['data-block-id'] = String(attrs.id);
  if (attrs.lang) result.lang = String(attrs.lang);
  if (attrs.dir) result.dir = String(attrs.dir);
  if (attrs.textAlign) result.style = `text-align: ${attrs.textAlign}`;
  return result;
}

function block(spec: NodeSpec): NodeSpec {
  const original = spec.toDOM;
  return {
    ...spec,
    attrs: { ...spec.attrs, ...commonAttrs },
    toDOM: original
      ? (node) => {
          const originalOutput = original(node);
          if (!Array.isArray(originalOutput)) return originalOutput;
          const output = originalOutput as readonly unknown[];
          if (typeof output[0] !== 'string') return originalOutput;
          const hasAttrs =
            output[1] !== null && typeof output[1] === 'object' && !Array.isArray(output[1]);
          const attrs = hasAttrs ? (output[1] as Record<string, unknown>) : {};
          return [
            output[0],
            { ...attrs, ...domAttrs(node.attrs) },
            ...output.slice(hasAttrs ? 2 : 1),
          ] as DOMOutputSpec;
        }
      : undefined,
  };
}

function createSchema(profile: DocumentProfile): Schema {
  const nodes: Record<string, NodeSpec> = {
    doc: { content: 'block+' },
    paragraph: block({ ...basicNodes.paragraph, attrs: { textAlign: { default: null } } }),
    heading: block({
      ...basicNodes.heading,
      attrs: { level: { default: 1 }, textAlign: { default: null } },
    }),
    blockquote: block(basicNodes.blockquote),
    bulletList: block({ ...bulletList, content: 'listItem+', group: 'block' }),
    orderedList: block({
      ...orderedList,
      attrs: { start: { default: 1 } },
      content: 'listItem+',
      group: 'block',
      parseDOM: [
        {
          tag: 'ol',
          getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute('start') || 1) }),
        },
      ],
      toDOM: (node) => ['ol', { start: node.attrs.start }, 0],
    }),
    listItem: block({ ...listItem, content: 'paragraph block*' }),
    taskList: block({
      group: 'block',
      content: 'taskItem+',
      toDOM: () => ['ul', { 'data-type': 'taskList' }, 0],
    }),
    taskItem: block({
      content: 'paragraph block*',
      defining: true,
      attrs: { checked: { default: false } },
      toDOM: (node) => ['li', { 'data-checked': String(node.attrs.checked) }, 0],
    }),
    codeBlock: block({ ...basicNodes.code_block, attrs: { language: { default: null } } }),
    horizontalRule: block(basicNodes.horizontal_rule),
    hardBreak: basicNodes.hard_break,
    text: basicNodes.text,
    ruby: {
      inline: true,
      group: 'inline',
      content: 'text*',
      attrs: { rt: {}, position: { default: 'over' }, lang: { default: null } },
      toDOM: (node) => [
        'ruby',
        { lang: node.attrs.lang, style: `ruby-position: ${node.attrs.position}` },
        ['span', 0],
        ['rt', node.attrs.rt],
      ],
    },
  };
  if (profile === 'blocks') {
    const tables = tableNodes({
      tableGroup: 'block',
      cellContent: 'block+',
      cellAttributes: {
        align: { default: null },
      },
    });
    nodes.table = block(tables.table);
    nodes.tableRow = block({ ...tables.table_row, content: '(tableCell | tableHeader)*' });
    nodes.table = { ...nodes.table, content: 'tableRow+' };
    nodes.tableCell = block(tables.table_cell);
    nodes.tableHeader = block(tables.table_header);
    nodes.image = block({
      group: 'block',
      atom: true,
      attrs: {
        src: {},
        alt: { default: null },
        title: { default: null },
        width: { default: null },
        height: { default: null },
      },
      toDOM: (node) => [
        'img',
        {
          src: node.attrs.src,
          alt: node.attrs.alt,
          title: node.attrs.title,
          width: node.attrs.width,
          height: node.attrs.height,
        },
      ],
    });
    nodes.media = block({
      group: 'block',
      atom: true,
      attrs: { src: {}, kind: {}, caption: { default: '' } },
      toDOM: (node) => [
        'figure',
        { 'data-media-kind': node.attrs.kind },
        node.attrs.caption || node.attrs.src,
      ],
    });
    const extensionAttrs = {
      id: { default: null },
      definition: {},
      version: {},
      payload: {},
      fallback: {},
    };
    nodes.extensionBlock = block({
      group: 'block',
      atom: true,
      attrs: extensionAttrs,
      toDOM: (node) => ['div', { 'data-extension': node.attrs.definition }, node.attrs.fallback],
    });
    nodes.extensionInline = {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: extensionAttrs,
      toDOM: (node) => ['span', { 'data-extension': node.attrs.definition }, node.attrs.fallback],
    };
  }
  const marks: Record<string, MarkSpec> = {
    bold: basicMarks.strong,
    italic: basicMarks.em,
    underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
    strike: { parseDOM: [{ tag: 's' }], toDOM: () => ['s', 0] },
    code: basicMarks.code,
    spoiler: {
      parseDOM: [{ tag: 'span[data-spoiler]' }],
      toDOM: () => ['span', { 'data-spoiler': 'true' }, 0],
    },
    link: {
      ...basicMarks.link,
      attrs: {
        href: {},
        target: { default: null },
        rel: { default: null },
        class: { default: null },
        title: { default: null },
      },
      toDOM: (mark) => ['a', mark.attrs, 0],
    },
    textStyle: {
      attrs: { color: { default: null }, backgroundColor: { default: null } },
      toDOM: (mark) => [
        'span',
        {
          style: [
            mark.attrs.color && `color: ${mark.attrs.color}`,
            mark.attrs.backgroundColor && `background-color: ${mark.attrs.backgroundColor}`,
          ]
            .filter(Boolean)
            .join('; '),
        },
        0,
      ],
    },
    textEmphasis: {
      attrs: {
        shape: { default: 'dot' },
        fill: { default: 'filled' },
        color: { default: null },
        position: { default: 'over' },
      },
      toDOM: (mark) => [
        'span',
        {
          style: `text-emphasis-style: ${mark.attrs.fill} ${mark.attrs.shape}; text-emphasis-position: ${mark.attrs.position};${mark.attrs.color ? `text-emphasis-color: ${mark.attrs.color}` : ''}`,
        },
        0,
      ],
    },
    language: {
      attrs: { lang: { default: null }, dir: { default: null } },
      toDOM: (mark) => ['span', domAttrs(mark.attrs), 0],
    },
  };
  return new Schema({ nodes, marks });
}

export const textDocumentSchema = createSchema('text');
export const blocksDocumentSchema = createSchema('blocks');
/** Default editor profile. Use textDocumentSchema for text-only acceptance. */
export const documentSchema = blocksDocumentSchema;
export function schemaForProfile(profile: DocumentProfile): Schema {
  return profile === 'text' ? textDocumentSchema : blocksDocumentSchema;
}

/**
 * The wire format of a profile: which nodes exist, what each may contain, and the shell of each
 * node (its type, attributes, text and marks, without content). The published JSON Schema and the
 * runtime checker are both built from these rules, so they cannot drift apart.
 */
interface WireRules {
  names: readonly string[];
  content: Readonly<Record<string, { allowed: readonly string[]; minItems: number }>>;
  shells: Readonly<Record<string, Record<string, TSchema>>>;
  mark: TSchema;
}

function wireRules(profile: DocumentProfile): WireRules {
  const names = profile === 'text' ? textNodeNames : blocksNodeNames;
  const inlineNames = [
    'text',
    'hardBreak',
    'ruby',
    ...(profile === 'blocks' ? ['extensionInline'] : []),
  ];
  const blockNames = names.filter(
    (name) =>
      ![
        'text',
        'hardBreak',
        'ruby',
        'extensionInline',
        'listItem',
        'taskItem',
        'tableRow',
        'tableCell',
        'tableHeader',
      ].includes(name),
  );
  const rule = (allowed: readonly string[], minItems = 0) => ({ allowed, minItems });
  const content = {
    doc: rule(blockNames, 1),
    paragraph: rule(inlineNames),
    heading: rule(inlineNames),
    blockquote: rule(blockNames, 1),
    bulletList: rule(['listItem'], 1),
    orderedList: rule(['listItem'], 1),
    listItem: rule(blockNames, 1),
    taskList: rule(['taskItem'], 1),
    taskItem: rule(blockNames, 1),
    codeBlock: rule(['text']),
    ruby: rule(['text']),
    table: rule(['tableRow'], 1),
    tableRow: rule(['tableCell', 'tableHeader'], 1),
    tableCell: rule(blockNames, 1),
    tableHeader: rule(blockNames, 1),
  };
  const mark = Type.Union(
    Object.entries(markAttributes).map(([name, attrs]) =>
      Type.Object(
        {
          type: Type.Literal(name),
          ...(Object.keys(attrs).length ? { attrs: Type.Object(attrs, closed) } : {}),
        },
        closed,
      ),
    ),
  );
  const shells: Record<string, Record<string, TSchema>> = {};
  for (const name of names) {
    const fields: Record<string, TSchema> = { type: Type.Literal(name) };
    if (nodeAttributes[name]) fields.attrs = Type.Object(nodeAttributes[name], closed);
    if (name === 'text') fields.text = Type.String({ minLength: 1 });
    if (inlineNames.includes(name)) fields.marks = Type.Optional(Type.Array(mark));
    shells[name] = fields;
  }
  return { names, content, shells, mark };
}

function wireSchema(profile: DocumentProfile): TSchema {
  const rules = wireRules(profile);
  const definition = (name: string) => `${profile}_${name}`;
  const array = ({ allowed, minItems }: { allowed: readonly string[]; minItems: number }) =>
    Type.Array(Type.Union(allowed.map((name) => Type.Ref(definition(name)))), { minItems });
  const defs: Record<string, TSchema> = {
    [definition('Mark')]: rules.mark,
    [definition('Document')]: Type.Object(
      {
        version: Type.Literal(documentVersion),
        profile: Type.Literal(profile),
        doc: Type.Ref(definition('Doc')),
      },
      closed,
    ),
    [definition('Doc')]: Type.Object(
      { type: Type.Literal('doc'), content: array(rules.content.doc!) },
      closed,
    ),
  };
  for (const name of rules.names) {
    const shell = rules.shells[name]!;
    const fields: Record<string, TSchema> = { type: shell.type! };
    if (shell.attrs) fields.attrs = shell.attrs;
    if (rules.content[name]) fields.content = Type.Optional(array(rules.content[name]));
    if (shell.text) fields.text = shell.text;
    if (shell.marks) fields.marks = Type.Optional(Type.Array(Type.Ref(definition('Mark'))));
    defs[definition(name)] = Type.Object(fields, closed);
  }
  return Type.Cyclic(defs, definition('Document'));
}

/**
 * Checks one node and its descendants against a profile's wire rules. Each node type's shell is a
 * schema without references, so the cost follows the node, not the size of the schema; resolving
 * the published schema's references would scan the whole schema for every node. Values must
 * already be plain JSON.
 */
export function wireNodeChecker(profile: DocumentProfile): (node: unknown) => boolean {
  const rules = wireRules(profile);
  const shells = new Map(
    rules.names.map((name) => [name, Type.Object(rules.shells[name]!, closed)] as const),
  );
  const content = new Map(
    Object.entries(rules.content).map(([name, rule]) => [name, { ...rule, allowed: new Set(rule.allowed) }]),
  );
  const check = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
    const { content: children, ...shell } = node as Record<string, unknown>;
    const schema = shells.get(String(shell.type));
    if (!schema || !Value.Check(schema, shell)) return false;
    if (children === undefined) return true;
    const rule = content.get(String(shell.type));
    if (!rule || !Array.isArray(children) || children.length < rule.minItems) return false;
    return children.every(
      (child) =>
        typeof child === 'object' &&
        child !== null &&
        rule.allowed.has(String((child as { type?: unknown }).type)) &&
        check(child),
    );
  };
  return check;
}

/** The node types a document may hold at its top level. */
export function topLevelNodeNames(profile: DocumentProfile): ReadonlySet<string> {
  return new Set(wireRules(profile).content.doc!.allowed);
}

export const TextSnapshotSchema = wireSchema('text');
export const BlocksSnapshotSchema = wireSchema('blocks');
export const DocumentSnapshotSchema = Type.Union([TextSnapshotSchema, BlocksSnapshotSchema]);

/** Core only fixes the shared JSON shape; profiles define names, values and content expressions. */
export const CoreSnapshotSchema = Type.Cyclic(
  {
    CoreMark: Type.Object(
      {
        type: Type.String({ minLength: 1 }),
        attrs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      closed,
    ),
    CoreNode: Type.Object(
      {
        type: Type.String({ minLength: 1 }),
        attrs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        content: Type.Optional(Type.Array(Type.Ref('CoreNode'))),
        text: Type.Optional(Type.String()),
        marks: Type.Optional(Type.Array(Type.Ref('CoreMark'))),
      },
      closed,
    ),
    CoreDocument: Type.Object(
      {
        version: Type.Literal(documentVersion),
        profile: choice(['text', 'blocks']),
        doc: Type.Object(
          { type: Type.Literal('doc'), content: Type.Array(Type.Ref('CoreNode')) },
          closed,
        ),
      },
      closed,
    ),
  },
  'CoreDocument',
);

/** Portable JSON Schema: local refs, with TypeBox metadata removed. */
export function documentJsonSchema(profile: DocumentProfile | 'core'): Record<string, unknown> {
  const source =
    profile === 'core'
      ? CoreSnapshotSchema
      : profile === 'text'
        ? TextSnapshotSchema
        : BlocksSnapshotSchema;
  const clean = (value: unknown, definition = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => clean(item));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('~') && !(definition && key === '$id'))
        .map(([key, item]) => [
          key,
          key === '$ref'
            ? `#/$defs/${String(item)}`
            : key === '$defs'
              ? Object.fromEntries(
                  Object.entries(item as Record<string, unknown>).map(([name, schema]) => [
                    name,
                    clean(schema, true),
                  ]),
                )
              : clean(item),
        ]),
    );
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://rezics.com/protocol/rezics-${profile === 'core' ? 'document-core' : profile}-v1.schema.json`,
    $comment:
      'Apache-2.0. Also enforce ProseMirror content expressions, one ID namespace and valid table spans; see README.',
    ...(clean(source) as Record<string, unknown>),
  };
}

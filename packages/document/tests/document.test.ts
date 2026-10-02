// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import {
  checkDocument,
  documentJsonSchema,
  documentParagraphs,
  documentText,
  documentVersion,
  fromMarkdown,
  fromPlainText,
  hasDocumentContent,
  normalizeDocument,
  parseDocument,
  parseStoredDocument,
  serializeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '../src/index.ts';

const paragraph = (id: string, text: string): DocumentNode => ({
  type: 'paragraph',
  attrs: { id },
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});
const snapshot = (
  content: DocumentNode[],
  profile: 'text' | 'blocks' = 'blocks',
): DocumentSnapshot => ({
  version: documentVersion,
  profile,
  doc: { type: 'doc', content },
});

test('plain text import preserves paragraphs, trailing newline and empty draft', () => {
  const imported = fromPlainText('漢字😀\r\n\r\nlast\n');
  expect(documentText(imported)).toBe('漢字😀\n\nlast\n');
  expect(documentParagraphs(imported).map((p) => p.text)).toEqual(['漢字😀', '', 'last', '']);
  expect(new Set(documentParagraphs(imported).map((p) => p.id)).size).toBe(4);
  expect(hasDocumentContent(fromPlainText(' \n'))).toBe(false);
  expect(checkDocument(fromPlainText(''))).toBe(true);
});

test('rich markup, ruby, nested lists and table cells retain IDs and base text', () => {
  const value = snapshot([
    {
      type: 'heading',
      attrs: { id: 'heading', level: 2, lang: 'zh-Hant-TW', dir: 'ltr' },
      content: [
        {
          type: 'ruby',
          attrs: { rt: 'ㄏㄢˋ', position: 'inter-character', lang: 'zh-Hant' },
          content: [{ type: 'text', text: '漢', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'text',
          text: '字😀',
          marks: [
            { type: 'link', attrs: { href: '/work' } },
            { type: 'textEmphasis', attrs: { shape: 'sesame', fill: 'filled', position: 'over' } },
          ],
        },
      ],
    },
    {
      type: 'bulletList',
      attrs: { id: 'list' },
      content: [
        {
          type: 'listItem',
          attrs: { id: 'item' },
          content: [
            paragraph('listed', '一'),
            { type: 'blockquote', attrs: { id: 'quote' }, content: [paragraph('quoted', '二')] },
          ],
        },
      ],
    },
    {
      type: 'table',
      attrs: { id: 'table' },
      content: [
        {
          type: 'tableRow',
          attrs: { id: 'row' },
          content: [
            { type: 'tableHeader', attrs: { id: 'cell-1' }, content: [paragraph('cell-p-1', 'A')] },
            { type: 'tableCell', attrs: { id: 'cell-2' }, content: [paragraph('cell-p-2', 'B')] },
          ],
        },
      ],
    },
  ]);
  expect(parseDocument(value)).toBe(value);
  const normalized = normalizeDocument(value);
  expect(documentText(normalized)).toBe('漢字😀\n一\n二\nA\nB');
  expect(documentParagraphs(normalized)[0]).toEqual({ id: 'heading', text: '漢字😀' });
  expect(parseStoredDocument(serializeDocument(normalized))).toEqual(normalized);
  expect(checkDocument({ ...value, profile: 'text' })).toBe(false);
});

test('opaque components preserve arbitrary JSON and count as content without text', () => {
  const payload = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: [{ x: 2 }] },
    exact: ['  字\n  ', false, null],
    future: { nested: [3, 2, 1] },
  };
  const value = snapshot([
    {
      type: 'extensionBlock',
      attrs: {
        id: 'component',
        definition: 'https://example.test/vega-lite',
        version: '1',
        payload,
        fallback: '',
      },
    },
  ]);
  expect(hasDocumentContent(value)).toBe(true);
  expect(documentText(value)).toBe('');
  const result = parseStoredDocument(serializeDocument(value));
  expect(result?.doc.content?.[0]?.attrs?.payload).toEqual(payload);
  expect(checkDocument({ ...value, profile: 'text' })).toBe(false);
});

test('strict ingress rejects unknown attrs, duplicate IDs, invalid nesting and lossy JSON values', () => {
  const p = paragraph('same', 'x');
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const extension = (payload: unknown) =>
    snapshot([
      {
        type: 'extensionBlock',
        attrs: {
          id: 'component',
          definition: 'example',
          version: '1',
          fallback: 'future',
          payload,
        },
      } as DocumentNode,
    ]);
  for (const invalid of [
    snapshot([p, p]),
    snapshot([{ ...p, attrs: { id: 'p', unknown: 'would be lost' } }]),
    snapshot([{ type: 'paragraph', content: [{ type: 'text', text: 'missing id' }] }]),
    snapshot([{ type: 'listItem', attrs: { id: 'item' }, content: [p] }]),
    snapshot([{ type: 'heading', attrs: { id: 'h', level: 7 } }]),
    snapshot([
      {
        ...p,
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold', attrs: { unknown: true } }] }],
      },
    ]),
    snapshot([{ type: 'unknown', attrs: { id: 'u' } }]),
    extension(undefined),
    extension(NaN),
    extension(cycle),
    extension(new Date()),
    extension([1, , 3]),
  ]) {
    expect(checkDocument(invalid)).toBe(false);
    expect(() => parseDocument(invalid)).toThrow(TypeError);
  }
});

test('invalid table spans are rejected and extension payload IDs are not document IDs', () => {
  const cell = (id: string, colspan = 1): DocumentNode => ({
    type: 'tableCell',
    attrs: { id, colspan },
    content: [paragraph(`${id}-p`, id)],
  });
  const row = (id: string, cells: DocumentNode[]): DocumentNode => ({
    type: 'tableRow',
    attrs: { id },
    content: cells,
  });
  expect(
    checkDocument(
      snapshot([
        {
          type: 'table',
          attrs: { id: 'table' },
          content: [row('r1', [cell('a', 2)]), row('r2', [cell('b')])],
        },
      ]),
    ),
  ).toBe(false);
  expect(
    checkDocument(
      snapshot([
        {
          type: 'table',
          attrs: { id: 'table' },
          content: [row('r1', [cell('a', 2)]), row('r2', [cell('b'), cell('c')])],
        },
      ]),
    ),
  ).toBe(true);
});

test('normalization merges adjacent matching text and serialization is key-order independent', () => {
  const a = snapshot([
    {
      type: 'paragraph',
      attrs: { id: 'p', lang: null },
      content: [
        { type: 'text', text: 'A', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'B', marks: [{ type: 'bold' }] },
      ],
    },
  ]);
  const b = snapshot([
    {
      type: 'paragraph',
      attrs: { lang: null, id: 'p' },
      content: [{ type: 'text', text: 'AB', marks: [{ type: 'bold' }] }],
    },
  ]);
  expect(serializeDocument(a)).toBe(serializeDocument(b));
  expect(normalizeDocument(a).doc.content?.[0]?.content).toHaveLength(1);
});

test('editor ID repair preserves existing unique units and does not mutate source', () => {
  const doc = {
    type: 'doc',
    content: [paragraph('old', 'A'), paragraph('old', 'B'), { type: 'paragraph' }],
  };
  let id = 0;
  const repaired = withDocumentIds(doc, () => `new-${++id}`);
  expect(repaired.content?.map((p) => p.attrs?.id)).toEqual(['old', 'new-1', 'new-2']);
  expect(doc.content[1].attrs?.id).toBe('old');
  expect(checkDocument({ version: documentVersion, profile: 'text', doc: repaired })).toBe(true);
  expect(parseStoredDocument('{"type":"paragraph","text":"authored JSON"}')).toBeNull();
});

test('published schemas match their source declaration', async () => {
  for (const profile of ['core', 'text', 'blocks'] as const) {
    const schema = await Bun.file(
      new URL(
        `../schema/rezics-${profile === 'core' ? 'document-core' : profile}-v1.schema.json`,
        import.meta.url,
      ),
    ).json();
    expect(schema).toEqual(documentJsonSchema(profile));
  }
});

test('CommonMark import retains marks, ordered list starts and promotes images without losing surrounding text', () => {
  const result = fromMarkdown(
    '# Heading\n\n**strong** and [link](/work)\n\n3. third\n4. fourth\n\nBefore ![alt](/image.png) after\n\n```ts\nconst x = 1;\n```',
  );
  expect(documentText(result)).toBe(
    'Heading\nstrong and link\nthird\nfourth\nBefore \nalt\n after\nconst x = 1;',
  );
  const ordered = result.doc.content?.find((node) => node.type === 'orderedList');
  expect(ordered?.attrs?.start).toBe(3);
  const image = result.doc.content?.find((node) => node.type === 'image');
  expect(image?.attrs?.src).toBe('/image.png');
  expect(checkDocument(result)).toBe(true);
  expect(documentText(fromMarkdown('<script>literal</script>'))).toBe('<script>literal</script>');
  expect(() => fromMarkdown('![alt](/image.png)', 'text')).toThrow(TypeError);
});

test('legacy inline spoilers retain concealment and inner formatting without interpreting code markers', () => {
  const result = fromMarkdown(
    '>!**ending**!<\n\nBefore >![secret](/work)!< after\n\n`>!literal!<`',
  );
  expect(documentText(result)).toBe('ending\nBefore secret after\n>!literal!<');
  const headingText = result.doc.content?.[0]?.content?.[0];
  expect(headingText?.marks?.map((mark) => mark.type)).toEqual(['bold', 'spoiler']);
  expect(
    result.doc.content?.[1]?.content
      ?.find((node) => node.text === 'secret')
      ?.marks?.map((mark) => mark.type),
  ).toEqual(['spoiler', 'link']);
  expect(result.doc.content?.[2]?.content?.[0]?.marks).toEqual([{ type: 'code' }]);
});

test('editing work is proportional to the edit: unchanged normalized blocks are reused, not rechecked', () => {
  const blocks = Array.from({ length: 50 }, (_, index) => paragraph(`p${index}`, `Line ${index}`));
  const first = normalizeDocument(snapshot(blocks));
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.doc.content![0])).toBe(true);
  expect(normalizeDocument(first)).toBe(first);
  expect(() => {
    (first.doc.content as DocumentNode[]).push(paragraph('late', 'mutation'));
  }).toThrow();

  // A keystroke changes one block; the other 49 keep their identity in the next snapshot.
  const edited = [...first.doc.content!];
  edited[7] = paragraph('p7', 'Line 7, edited');
  const second = normalizeDocument(snapshot(edited));
  expect(second.doc.content![6]).toBe(first.doc.content![6]);
  expect(second.doc.content![7]).not.toBe(first.doc.content![7]);
  expect(documentText(second).split('\n')[7]).toBe('Line 7, edited');

  // Reused blocks still take part in the checks that span the document.
  const duplicated = [...first.doc.content!, first.doc.content![0]!];
  expect(checkDocument(snapshot(duplicated))).toBe(false);
  const table = normalizeDocument(snapshot([{ type: 'table', attrs: { id: 't' }, content: [{ type: 'tableRow', attrs: { id: 'r' },
    content: [{ type: 'tableCell', attrs: { id: 'c' }, content: [paragraph('cp', 'cell')] }] }] }]));
  expect(checkDocument(snapshot([...table.doc.content!], 'text'))).toBe(false);
});

test('serialization is the sorted JSON of the normalized snapshot, and its text reads back without parsing', () => {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted)
      : value === null || typeof value !== 'object' ? value
        : Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]));
  const value = snapshot([paragraph('a', 'ä "quoted" \\ 😀'), { type: 'horizontalRule', attrs: { id: 'h' } }]);
  const text = serializeDocument(value);
  expect(text).toBe(JSON.stringify(sorted(normalizeDocument(value))));
  expect(parseStoredDocument(text)).toBe(normalizeDocument(parseStoredDocument(text)!));
  expect(parseStoredDocument(JSON.stringify(JSON.parse(text)))).toEqual(normalizeDocument(value));
});

test('the runtime node checker accepts exactly what the published schema accepts', async () => {
  const { Value } = await import('typebox/value');
  const { DocumentSnapshotSchema, topLevelNodeNames, wireNodeChecker } = await import('../src/schema.ts');
  const rich: DocumentNode[] = [
    { type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: 'Title', marks: [{ type: 'bold' }] }] },
    { type: 'paragraph', attrs: { id: 'p', lang: 'ja', dir: 'ltr' }, content: [
      { type: 'ruby', attrs: { rt: 'かん', position: 'over' }, content: [{ type: 'text', text: '漢' }] },
      { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.test/' } }] },
      { type: 'hardBreak' },
    ] },
    { type: 'bulletList', attrs: { id: 'l' }, content: [{ type: 'listItem', attrs: { id: 'li' }, content: [paragraph('lp', 'item')] }] },
    { type: 'blockquote', attrs: { id: 'q' }, content: [paragraph('qp', 'quoted')] },
    { type: 'codeBlock', attrs: { id: 'c' }, content: [{ type: 'text', text: 'x = 1' }] },
    { type: 'table', attrs: { id: 't' }, content: [{ type: 'tableRow', attrs: { id: 'r' },
      content: [{ type: 'tableCell', attrs: { id: 'tc' }, content: [paragraph('tp', 'cell')] }] }] },
    { type: 'horizontalRule', attrs: { id: 'hr' } },
  ];
  const mutations: ((node: Record<string, unknown>) => void)[] = [
    (node) => { delete node.attrs; },
    (node) => { node.attrs = { ...(node.attrs as object), unknown: true }; },
    (node) => { node.extra = 1; },
    (node) => { node.type = 'unknownType'; },
    (node) => { node.content = []; },
    (node) => { node.content = [{ type: 'text', text: '' }]; },
    (node) => { node.content = [{ type: 'paragraph', attrs: { id: 'n' } }]; },
    (node) => { node.marks = [{ type: 'bold' }]; },
    (node) => { node.marks = [{ type: 'noSuchMark' }]; },
    (node) => { node.text = 'loose text'; },
    (node) => { node.attrs = { ...(node.attrs as object), level: 9 }; },
  ];
  const walk = (node: DocumentNode, path: number[] = []): number[][] =>
    [path, ...(node.content ?? []).flatMap((child, index) => walk(child, [...path, index]))];
  let compared = 0;
  for (const profile of ['text', 'blocks'] as const) {
    const check = wireNodeChecker(profile);
    const top = topLevelNodeNames(profile);
    const runtime = (value: DocumentSnapshot) =>
      (value.doc.content ?? []).length > 0 && value.doc.content!.every((block) => top.has(block.type) && check(block));
    const doc = { type: 'doc', content: rich } as DocumentNode;
    for (const path of walk(doc).filter((path) => path.length)) {
      for (const mutate of mutations) {
        const copy = structuredClone(doc);
        let target = copy;
        for (const index of path) target = target.content![index]!;
        mutate(target as unknown as Record<string, unknown>);
        const value = snapshot(copy.content!, profile);
        expect(runtime(value)).toBe(Value.Check(DocumentSnapshotSchema, value));
        compared++;
      }
    }
    expect(runtime(snapshot(rich, profile))).toBe(Value.Check(DocumentSnapshotSchema, snapshot(rich, profile)));
  }
  expect(compared).toBeGreaterThan(300);
  // The reference resolves the published schema's references for every node, which is the cost the runtime checker avoids.
}, 180_000);

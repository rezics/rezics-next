import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import {
  MAX_PAGE_COST,
  planReads,
  platformRegistry,
  readCost,
  resolveTemplate,
  UI_LOCALES,
  validateComposition,
  validateDocumentFilters,
} from '@rezics/composition';
import { platformProfile } from '../../src/presentation/setup.ts';

type Node = { type: string; props: Record<string, unknown> };
function* walk(nodes: readonly Node[]): Generator<Node> {
  for (const node of nodes) {
    yield node;
    for (const value of Object.values(node.props))
      if (Array.isArray(value) && value.every((item) => typeof item?.type === 'string' && item.props))
        yield* walk(value as Node[]);
  }
}
const home = () => resolveTemplate(platformProfile(), { route: '/' });

test('the site home is a route page with search and a popular list per vertical', () => {
  const page = home();
  expect(page).toMatchObject({ scope: 'route', key: '/' });
  expect(validateComposition(platformRegistry, page.document)).toEqual([]);
  expect(validateDocumentFilters(platformRegistry, page.document, bundledRelease)).toEqual([]);
  const nodes = [...walk(page.document.content as Node[])];
  expect(nodes.slice(0, 2).map((node) => node.type)).toEqual(['Heading', 'SearchBox']);
  expect(nodes.some(({ type }) => type === 'LinkGrid')).toBe(false);
  const reads = Object.values(planReads(platformRegistry, page.document, { subject: null }).reads);
  expect(
    reads.map((read) => (read.kind === 'search' && 'type' in read.body.filter ? read.body.filter.type.in : [])),
  ).toEqual([['schema:Book'], ['schema:TVSeries', 'schema:Movie'], ['wd:Q689445'], ['schema:Recipe']]);
  for (const read of reads) {
    expect(read).toMatchObject({ kind: 'search', body: { sort: 'collections', limit: 12 } });
    if (read.kind === 'search') expect(() => admitFilter(parseFilter(read.body.filter), bundledRelease)).not.toThrow();
  }
  expect(reads.reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(MAX_PAGE_COST);
});

test('a TypeList whose selector is absent from the release stays invalid', () => {
  const page = home();
  const list = [...walk(page.document.content as Node[])].find((node) => node.type === 'TypeList')!;
  list.props.types = ['schema:NotReleased'];
  expect(validateDocumentFilters(platformRegistry, page.document, bundledRelease)).toContainEqual({
    pointer: '/content/2/props/filter/type/in/0',
    code: 'invalid',
  });
});

test('every home text is written in all eight locales', () => {
  const texts: unknown[] = [];
  for (const node of walk(home().document.content as Node[])) {
    if (node.type === 'SearchBox') texts.push(node.props.placeholder);
    if (node.type === 'TypeList' || node.type === 'Heading' || node.type === 'Text')
      texts.push(node.props.title ?? node.props.text);
  }
  expect(texts.length).toBeGreaterThanOrEqual(6);
  for (const text of texts) {
    expect(Object.keys(text as object).sort()).toEqual([...UI_LOCALES].sort());
    for (const value of Object.values(text as Record<string, string>)) expect(value.trim().length).toBeGreaterThan(0);
  }
});

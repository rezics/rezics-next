import { expect, test } from 'bun:test';
import { continuationInventory } from './web-continuations.ts';
import { pageSelections } from './web-page-filtering.ts';

const source = (source: string) => ({ path: 'apps/web/features/example/native.ts', source });
const native = `export function project(page) { return { items: page.items, next: page.next }; }`;
const partition = `export function project(page) {
  const matching = [];
  const remaining = [];
  for (const entry of page.items) {
    if (entry.kind === 'collection') matching.push(entry); else remaining.push(entry);
  }
  return { page, matching, remaining };
}`;
const caller = source(`export async function caller(api) {
  const page = await api.v1.resources({resource:'subject'}).relations.get({query:{limit:20}});
  return project(page);
}`);
const predicates = (text: string) => pageSelections([source(text), caller]);

test.each([native, native.replaceAll('page', 'answer'), native.replace('project(page)', 'project(page: RelationsPage)')])(
  'native next forwards the same unmodified envelope', text => {
    expect(continuationInventory([source(text)])).toEqual([]);
  },
);

test.each([
  native.replace(', next: page.next', ''),
  native.replace('next: page.next', 'next: null'),
  native.replace('next: page.next', 'next: other.next'),
  native.replace('next: page.next', 'next: page.next + "suffix"'),
  native.replace('next: page.next', 'next: page.items.length ? page.next : null'),
  native.replace('next: page.next', 'next: page.next, ...other'),
  native.replace('next: page.next', '...other, next: page.next'),
  native.replace('next: page.next', 'next: page.next, next: null'),
  native.replace('next: page.next', 'next: page.next, items: []'),
  native.replace('return', 'page.next = null; return'),
  native.replace('return', 'page.items.length = 0; return'),
  native.replace('return', 'const alias = page; alias.next = null; return'),
  native.replace('return', 'const alias = page.items; alias.length = 0; return'),
  native.replace('return', 'const alias = {items: page.items}; alias.items.length = 0; return'),
  native.replace('return', 'const alias = {page}; mutate(alias); return'),
  native.replace('return', 'mutate(page); return'),
  native.replace('return', 'function shadow(page) {} return'),
  native.replace('page.items', 'page.items.slice(0, 1)'),
  native.replace('page.items', 'page.items.filter(eligible)'),
])('native forwarding refuses planted page/token loss and uncertain alias flows', text => {
  expect(continuationInventory([source(text)]).some(row => row.rule === 'dropped-continuation')).toBe(true);
});

test.each([partition, partition.replaceAll('page', 'answer').replaceAll('matching', 'left').replaceAll('remaining', 'right')])(
  'a retained page and exhaustive unchanged incidence partition preserve next and every occurrence', text => {
    expect(continuationInventory([source(text)])).toEqual([]);
    expect(predicates(text)).toEqual([]);
  },
);

test.each([
  partition.replace('page, matching, remaining', 'matching, remaining'),
  partition.replace('page, matching, remaining', 'page: {...page, next:null}, matching, remaining'),
  partition.replace('page, matching, remaining', 'page: other, matching, remaining'),
  partition.replace('page, matching, remaining', 'page: matching, matching: remaining, remaining: page'),
  partition.replace('page, matching, remaining', 'page, matching'),
  partition.replace('page, matching, remaining', 'page, matching: matching.slice(0, 1), remaining'),
  partition.replace('page, matching, remaining', 'page, matching: matching.filter(eligible), remaining'),
  partition.replace('page, matching, remaining', 'page, matching, remaining, ...other'),
  partition.replace('page, matching, remaining', 'page, matching, remaining, page: other'),
  partition.replace('page, matching, remaining', '__proto__: page, matching, remaining'),
  partition.replace('else remaining.push(entry)', 'else ;'),
  partition.replace('matching.push(entry)', 'remaining.push(entry)'),
  partition.replace('return {', 'page.next = null; return {'),
  partition.replace('return {', 'matching.length = 0; return {'),
  partition.replace('return {', 'function shadow(page) {} return {'),
  partition.replace('return {', 'const alias = page; alias.next = null; return {'),
  partition.replace("entry.kind === 'collection'", 'mutate(page)'),
  partition.replace('page.items', 'page.items.slice(0, 1)'),
  partition.replace('page.items', 'page.items.filter(eligible)'),
])('both native page guards refuse a lossy, mutated, shadowed or overridden partition: %s', text => {
  expect(continuationInventory([source(text)]).length).toBeGreaterThan(0);
  expect(predicates(text).length).toBeGreaterThan(0);
});

test('page/function/type names and unverified helper output cannot establish preservation', () => {
  const unknown = `export function relationPageGroups(page: RelationsPage) {
    return { page, groups: groupRelations(page.items) };
  }`;
  expect(continuationInventory([source(unknown)]).length).toBeGreaterThan(0);
  expect(continuationInventory([source(unknown.replace('groupRelations(page.items)', 'page.items.filter(eligible)'))]).length).toBeGreaterThan(0);
});

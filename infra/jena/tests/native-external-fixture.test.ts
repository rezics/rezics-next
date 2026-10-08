import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const javaTests = join(root, 'infra/jena/command-module/src/test/java');
const wrapperPath = join(root, 'infra/jena/tests/work-name-scope-basis.test.ts');

/** Java comments are not annotations. Strings are kept so a quoted example cannot hide a real use. */
export function stripJavaComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length;) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      out += quote;
      i += 1;
      while (i < source.length) {
        const current = source[i]!;
        out += current;
        i += 1;
        if (current === '\\' && i < source.length) { out += source[i]; i += 1; continue; }
        if (current === quote) break;
      }
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function className(fileName: string): string {
  return fileName.endsWith('.java') ? fileName.slice(0, -5) : fileName;
}

function isExternalFixture(typeName: string): boolean {
  return typeName === 'ExternalFixture' || typeName === 'com.rezics.jena.ExternalFixture';
}

export function categoryTypes(source: string): string[] {
  const names: string[] = [];
  for (const annotation of stripJavaComments(source).matchAll(/@Category\s*\(([\s\S]*?)\)/g)) {
    for (const type of annotation[1]!.matchAll(/([\w.]+)\.class/g)) names.push(type[1]!);
  }
  return names;
}

export function readsFixtureProperty(source: string): boolean {
  return /System\.getProperty\(\s*"rezics\.title\.candidate\.fixture"\s*\)/.test(stripJavaComments(source));
}

export function wrapperRunSet(wrapperSource: string): string[] {
  const names = new Set<string>();
  for (const match of wrapperSource.matchAll(/-Dtest=([A-Za-z0-9_,]+)/g)) {
    for (const name of match[1]!.split(',')) if (name) names.add(name);
  }
  return [...names].sort();
}

export interface ExternalFixtureInventory {
  tagged: string[];
  fixturePropertyClasses: string[];
  runSet: string[];
}

export function inventoryExternalFixtures(sources: ReadonlyMap<string, string>, wrapperSource: string): ExternalFixtureInventory {
  const tagged: string[] = [];
  const fixturePropertyClasses: string[] = [];
  for (const [fileName, source] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = className(fileName.split('/').pop()!);
    if (categoryTypes(source).some(isExternalFixture)) tagged.push(name);
    if (readsFixtureProperty(source)) fixturePropertyClasses.push(name);
  }
  return { tagged, fixturePropertyClasses, runSet: wrapperRunSet(wrapperSource) };
}

/** Empty when every tagged class is executed by the wrapper and every fixture-property class is tagged. */
export function externalFixtureProblems(sources: ReadonlyMap<string, string>, wrapperSource: string): string[] {
  const found = inventoryExternalFixtures(sources, wrapperSource);
  const run = new Set(found.runSet);
  const tagged = new Set(found.tagged);
  const problems: string[] = [];
  for (const name of found.tagged) {
    if (!run.has(name)) problems.push(`${name} carries @Category(ExternalFixture.class) but is absent from the wrapper run set`);
  }
  for (const name of found.fixturePropertyClasses) {
    if (!tagged.has(name)) problems.push(`${name} reads rezics.title.candidate.fixture without @Category(ExternalFixture.class)`);
  }
  return problems;
}

function assertAccepted(sources: ReadonlyMap<string, string>, wrapperSource: string): void {
  const problems = externalFixtureProblems(sources, wrapperSource);
  if (problems.length) throw new Error(problems.join('\n'));
}

function javaSources(directory: string): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.java')) sources.set(name, readFileSync(path, 'utf8'));
    }
  };
  walk(directory);
  return sources;
}

const sources = javaSources(javaTests);
const wrapper = readFileSync(wrapperPath, 'utf8');

test('the external fixture category inventory is exactly the focused wrapper run', () => {
  const found = inventoryExternalFixtures(sources, wrapper);
  expect(found.tagged).toEqual(['TitleCandidateCommandTest']);
  expect(found.fixturePropertyClasses).toEqual(['TitleCandidateCommandTest']);
  expect(found.runSet).toContain('TitleCandidateCommandTest');
  expect(externalFixtureProblems(sources, wrapper)).toEqual([]);
  expect(categoryTypes(sources.get('ExternalFixture.java') ?? '')).toEqual([]);
});

test('a tagged class absent from the wrapper run set fails', () => {
  const mutated = new Map(sources);
  mutated.set('DecoyExternalTest.java', [
    'package com.rezics.jena;',
    'import org.junit.experimental.categories.Category;',
    '@Category({ExternalFixture.class})',
    'public class DecoyExternalTest {}',
  ].join('\n'));
  expect(() => assertAccepted(mutated, wrapper)).toThrow(
    'DecoyExternalTest carries @Category(ExternalFixture.class) but is absent from the wrapper run set',
  );
});

test('dropping the tagged class from the wrapper run set fails', () => {
  const dropped = wrapper.replace('TitleCandidateCommandTest,', '');
  expect(wrapperRunSet(dropped)).not.toContain('TitleCandidateCommandTest');
  expect(() => assertAccepted(sources, dropped)).toThrow(
    'TitleCandidateCommandTest carries @Category(ExternalFixture.class) but is absent from the wrapper run set',
  );
});

test('a fixture system property class without the category fails', () => {
  const mutated = new Map(sources);
  const original = mutated.get('TitleCandidateCommandTest.java');
  if (!original?.includes('@Category(ExternalFixture.class)')) throw new Error('missing live category annotation');
  mutated.set('TitleCandidateCommandTest.java', original.replace('@Category(ExternalFixture.class)\n', ''));
  expect(categoryTypes(mutated.get('TitleCandidateCommandTest.java')!)).not.toContain('ExternalFixture');
  expect(readsFixtureProperty(mutated.get('TitleCandidateCommandTest.java')!)).toBe(true);
  expect(() => assertAccepted(mutated, wrapper)).toThrow(
    'TitleCandidateCommandTest reads rezics.title.candidate.fixture without @Category(ExternalFixture.class)',
  );
});

test('comments that mention the category or fixture property are not inventory hits', () => {
  const mutated = new Map(sources);
  mutated.set('CommentOnly.java', [
    'package com.rezics.jena;',
    '// @Category(ExternalFixture.class)',
    '/* System.getProperty("rezics.title.candidate.fixture") */',
    'public class CommentOnly {}',
  ].join('\n'));
  const found = inventoryExternalFixtures(mutated, wrapper);
  expect(found.tagged).toEqual(['TitleCandidateCommandTest']);
  expect(found.fixturePropertyClasses).toEqual(['TitleCandidateCommandTest']);
  expect(externalFixtureProblems(mutated, wrapper)).toEqual([]);
});

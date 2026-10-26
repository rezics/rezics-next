import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type AccessLiteral = Readonly<{ name: string; kind: 'typed' | 'returned' }>;

const allowed = new Map([
  ['community/work.ts', new Set(['followAccess'])],
  ['request/access.ts', new Set(['anonymousAccess'])],
  ['semantic/setup.ts', new Set(['access'])],
]);

function accessLiterals(source: string): AccessLiteral[] {
  const literals: AccessLiteral[] = [];
  for (const match of source.matchAll(/\b(?:const|let|var) ([A-Za-z_$][\w$]*): Access = \{/g)) {
    literals.push({ name: match[1]!, kind: 'typed' });
  }
  const functions =
    /(?:^|\n)(?:export )?function ([A-Za-z_$][\w$]*)\((?:(?!^\}).)*?\): Access \{(?<body>(?:(?!^\}).)*)^\}/gms;
  for (const match of source.matchAll(functions)) {
    if (/^\s+return \{/m.test(match.groups!.body!)) {
      literals.push({ name: match[1]!, kind: 'returned' });
    }
  }
  return literals;
}

test('Access adapters outside access use deriveAccess', () => {
  const sourceDirectory = resolve(import.meta.dir, '../../src');
  const violations: string[] = [];
  for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: sourceDirectory })) {
    if (file.startsWith('access/')) continue;
    for (const literal of accessLiterals(readFileSync(resolve(sourceDirectory, file), 'utf8'))) {
      if (!allowed.get(file)?.has(literal.name)) violations.push(`${file}: ${literal.name} (${literal.kind})`);
    }
  }
  expect(violations).toEqual([]);
});

test('the Access adapter guard rejects typed and returned object literals', () => {
  expect(
    accessLiterals(`const a: Access = {
  authenticate,
  authorize,
};`),
  ).toEqual([{ name: 'a', kind: 'typed' }]);
  expect(
    accessLiterals(`function adapter(): Access {
  return {
    authenticate,
    authorize,
  };
}`),
  ).toEqual([{ name: 'adapter', kind: 'returned' }]);
});

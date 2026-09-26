import { expect, test } from 'bun:test';
import { parseGoModRequirements } from
  '../../../services/main/src/modules/package/go-mod-parser.ts';

test('PKG05: bounded Go 1.16 require syntax yields an explicit parsed graph', () => {
  const parsed = parseGoModRequirements(`module example.com/a
go 1.16
require (
  example.com/b v1.2.0 // indirect
  example.com/c/v2 v2.1.0
)
require example.com/d v0.1.0
`, 'example.com/a');
  expect(parsed).toEqual({ profile: 'go-mod-requirements-v1', status: 'parsed',
    declaredModule: 'example.com/a', goDirective: '1.16',
    requirements: [{ path: 'example.com/b', version: 'v1.2.0' },
      { path: 'example.com/c/v2', version: 'v2.1.0' },
      { path: 'example.com/d', version: 'v0.1.0' }],
    unsupportedClauses: [], compatibleWithUnprunedGo116: true });
});

test('PKG05/PKG13: unsupported manifest syntax never exposes a partial graph', () => {
  const parsed = parseGoModRequirements(`module example.com/a
go 1.16
require example.com/b v1.0.0
require example.com/c v0.0.0-20200101000000-abcdefabcdef
replace example.com/b => ../b
`, 'example.com/a');
  expect(parsed).toMatchObject({ status: 'unsupported-syntax',
    requirements: [], unsupportedClauses: ['replace example.com/b => ../b'] });
  expect(parseGoModRequirements('module example.com/wrong\n', 'example.com/a'))
    .toMatchObject({ status: 'unsupported-syntax', requirements: [] });
  expect(parseGoModRequirements('module golang.org/x/sync\n', 'golang.org/x/sync'))
    .toMatchObject({ status: 'parsed', requirements: [],
      compatibleWithUnprunedGo116: false });
});

test('PKG05: bounded Go pseudo-version requirements retain exact manifest identity', () => {
  expect(parseGoModRequirements(`module example.com/a
go 1.16
require example.com/c/v2 v2.0.0-20260925010101-abcdef123456
`, 'example.com/a')).toMatchObject({ status: 'parsed',
    requirements: [{ path: 'example.com/c/v2',
      version: 'v2.0.0-20260925010101-abcdef123456' }] });
  expect(parseGoModRequirements(`module example.com/a
go 1.16
require example.com/c v1.2.4-0.20260925010101-abcdef123456
`, 'example.com/a')).toMatchObject({ status: 'parsed',
    requirements: [{ path: 'example.com/c',
      version: 'v1.2.4-0.20260925010101-abcdef123456' }] });
});

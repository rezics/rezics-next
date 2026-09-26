import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { pinnedPseudoProvenance, verifyPseudoOracleBinding, PINNED_PSEUDO }
  from '../../../scripts/package/go-checksum-provenance.ts';
import type { IncludedGoSumdbLookup }
  from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import fixture from '../fixtures/go-sumdb-rsc-markdown.json';

const manifest = `module cmd\n\nrequire (\n rsc.io/markdown ${PINNED_PSEUDO.version} // indirect\n)\n`;
const sums = `rsc.io/markdown ${PINNED_PSEUDO.version} ${fixture.source.officialModuleH1}\n`
  + `rsc.io/markdown ${PINNED_PSEUDO.version}/go.mod ${fixture.source.officialGoModH1}\n`;
const mod = Buffer.from('module rsc.io/markdown\n\ngo 1.20\n\nrequire (\n'
  + '\tgithub.com/yuin/goldmark v1.6.0 // for testing only\n'
  + '\tgolang.org/x/text v0.3.7\n\tgolang.org/x/tools v0.1.5\n)\n');
const info = Buffer.from(JSON.stringify({ Version: PINNED_PSEUDO.version,
  Time: '2024-03-06T14:43:22Z' }));
const native = { Path: PINNED_PSEUDO.path, Version: PINNED_PSEUDO.version,
  Sum: fixture.source.officialModuleH1,
  GoModSum: fixture.source.officialGoModH1 };
const included = fixture.includedLookup as IncludedGoSumdbLookup;

test('PKG05/PKG14/PKG20: official Go pseudo source binds exact capture and signed record', () => {
  const source = pinnedPseudoProvenance(manifest, sums);
  expect(verifyPseudoOracleBinding(source, { info, mod }, native, included))
    .toBe(fixture.source.capturedManifestSha256);
  expect(() => pinnedPseudoProvenance(manifest.replace(PINNED_PSEUDO.version,
    'v0.0.0-20240306144323-0bf8f97ee8ef'), sums)).toThrow();
  expect(() => pinnedPseudoProvenance(manifest, sums.replace('/go.mod ', '/go.mod h1:bad ')))
    .toThrow();
  expect(() => verifyPseudoOracleBinding(source, { info, mod },
    { ...native, Version: 'v0.1.0' }, included)).toThrow();
  expect(() => verifyPseudoOracleBinding(source, { info,
    mod: Buffer.from('module rsc.io/markdown\n') }, native, included)).toThrow();
  expect(() => verifyPseudoOracleBinding(source, { info, mod },
    { ...native, GoModSum: 'h1:bad' }, included)).toThrow();
  expect(() => verifyPseudoOracleBinding(source, { info, mod }, native,
    { ...included, recordSha256: '0'.repeat(64) })).toThrow();
  const changedRecord = Buffer.from(included.recordTextBase64, 'base64')
    .toString().replace(source.officialGoModH1, 'h1:' + 'A'.repeat(43) + '=');
  expect(() => verifyPseudoOracleBinding(source, { info, mod }, native,
    { ...included, recordTextBase64: Buffer.from(changedRecord).toString('base64'),
      recordSha256: createHash('sha256').update(changedRecord).digest('hex') }))
    .toThrow();
  expect(() => verifyPseudoOracleBinding(source, { info, mod }, native,
    { ...included, tree: { ...included.tree, rootHash: Buffer.alloc(32).toString('base64') } }))
    .toThrow();
});

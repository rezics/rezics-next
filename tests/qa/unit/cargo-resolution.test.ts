import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CargoResolutionInvalid, solveCargoSnapshot }
  from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoFixture, withIndexLine } from '../fixtures/cargo-snapshot.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function secondSharedVersion(version: string) {
  const base = withIndexLine(cargoFixture(), 'bridge', entry => ({ ...entry,
    deps: (entry.deps as Array<Record<string, unknown>>).map(dep =>
      ({ ...dep, req: `=${version}` })) }));
  return { ...base, indexFiles: base.indexFiles.map(file => {
    if (file.name !== 'shared') return file;
    const first = JSON.parse(Buffer.from(file.bytesBase64, 'base64').toString('utf8'));
    const text = `${JSON.stringify(first)}\n${JSON.stringify({ ...first, vers: version })}\n`;
    return { ...file, bytesBase64: Buffer.from(text).toString('base64'),
      sha256: sha(text) };
  }) };
}

test('PKG01/PKG12: Cargo resolver 2 retains source, lock selection and host/target features', () => {
  const input = cargoFixture();
  const result = solveCargoSnapshot(input);
  expect(result.status).toBe('solved');
  expect(result.selected.map(item => item.name)).toEqual([
    'bridge', 'optionaldep', 'shared', 'windowsonly']);
  expect(result.instances.filter(item => item.name === 'shared')).toMatchObject([
    { role: 'host', features: ['build_extra'] },
    { role: 'target', features: ['indirect', 'runtime'] },
  ]);
  expect(result.instances.some(item => item.name === 'windowsonly')).toBe(false);
  expect(result.instances.some(item => item.name === 'optionaldep')).toBe(true);
  expect(result.edges.filter(edge => edge.to.includes('shared@1.0.0'))
    .map(edge => edge.kind).sort()).toEqual(['build', 'normal', 'normal']);
  const withoutDefaults = solveCargoSnapshot({ ...input, defaultFeatures: false });
  expect(withoutDefaults.status).toBe('solved');
  expect(withoutDefaults.instances.some(item => item.name === 'optionaldep')).toBe(false);
  expect(withoutDefaults.selected.some(item => item.name === 'optionaldep')).toBe(true);
  const incompatible = solveCargoSnapshot(secondSharedVersion('2.0.0'));
  expect(incompatible.status).toBe('solved');
  expect(incompatible.selected.filter(item => item.name === 'shared')
    .map(item => item.version)).toEqual(['1.0.0', '2.0.0']);
  expect(incompatible.instances.filter(item => item.name === 'shared')
    .map(item => item.version)).toContain('2.0.0');
  expect(solveCargoSnapshot(secondSharedVersion('1.1.0')).status)
    .toBe('unsupported-semantics');
});

test('PKG02/PKG13: Cargo unsupported, incomplete, malformed and budget outcomes stay distinct', () => {
  const input = cargoFixture();
  expect(solveCargoSnapshot({ ...input,
    indexFiles: input.indexFiles.filter(file => file.name !== 'shared') })).toMatchObject({
    status: 'incomplete-source-data', selected: [], instances: [],
    missing: ['shared@1.0.0'] });
  expect(solveCargoSnapshot(withIndexLine(input, 'shared', entry =>
    ({ ...entry, links: 'native_shared' })))).toMatchObject({
    status: 'unsupported-semantics', selected: [], instances: [] });
  expect(solveCargoSnapshot(withIndexLine(input, 'shared', entry =>
    ({ ...entry, yanked: true })))).toMatchObject({
    status: 'unsupported-semantics', selected: [], instances: [] });
  expect(() => solveCargoSnapshot({ ...input, manifestSha256: '0'.repeat(64) }))
    .toThrow(CargoResolutionInvalid);
  expect(() => solveCargoSnapshot({ ...input,
    indexFiles: [...input.indexFiles, input.indexFiles[0]!] }))
    .toThrow(CargoResolutionInvalid);
  const tooMany = withIndexLine(input, 'shared', entry => ({ ...entry,
    deps: Array.from({ length: 257 }, (_, index) => ({ name: `dep${index}`,
      req: '=1.0.0', features: [], optional: false,
      default_features: true, target: null, kind: 'normal', registry: null,
      package: null })) }));
  expect(solveCargoSnapshot(tooMany).status).toBe('budget-exhausted');
});

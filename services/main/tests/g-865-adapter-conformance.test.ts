import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { discoverEditorialAdapters } from '../src/modules/editorial-review/adapters.ts';
import { componentFixture } from './g-865-component-correction-fixture.ts';
import { runEditorialAdapterConformance, runEditorialOrderedConformance, runEditorialRefusalConformance, type AdapterFixtureModule } from './g-865-conformance.ts';

const adapters = await discoverEditorialAdapters();
const fixtures = new Map<string, AdapterFixtureModule>();
for (const file of [...new Bun.Glob('g-865-*-fixture.ts').scanSync({ cwd: import.meta.dir })].sort()) {
  const { fixtureModule } = await import(join(import.meta.dir, file)) as { fixtureModule: AdapterFixtureModule };
  if (!fixtureModule || fixtures.has(fixtureModule.kind)) throw new Error(`Invalid adapter conformance fixture: ${file}`);
  fixtures.set(fixtureModule.kind, fixtureModule);
}
test('G865: every discovered editorial adapter has a class conformance fixture', () => {
  expect([...fixtures.keys()].sort()).toEqual([...adapters.keys()].sort());
});
for (const [kind, fixture] of fixtures) {
  test(`G865: ${kind} stale approval, self-review, missing receipt, single terminal and lost acknowledgement`,
    () => runEditorialAdapterConformance(fixture));
  test(`G865: ${kind} ordered commands resume partial delivery and replay every outcome`,
    () => runEditorialOrderedConformance(fixture));
  test(`G927: ${kind} owner refusals fail closed before completion and during receipt-only recovery`,
    () => runEditorialRefusalConformance(fixture));
}
test('G865: the semantic date adapter binding runs the same lifecycle conformance guard', () =>
  runEditorialAdapterConformance({ kind: 'component-correction', create: () => componentFixture('semantic-change') }));

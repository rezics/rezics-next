import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareOwnerErasureSource } from './owner-restore-erasure-fixture.ts';

test('explicit preparation retains one owner-erasure source for isolated recovery consumers', async () => {
  const prepared = await prepareOwnerErasureSource();
  expect(prepared.manifest.key).toMatch(/^rs-owner-erasure-source-[0-9a-f]{64}$/);
  expect(prepared.manifest.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'owner-erasure-source-build.json'),
    JSON.stringify(prepared, null, 2), { mode: 0o600 });
}, 1_320_000);

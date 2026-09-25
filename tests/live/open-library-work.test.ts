import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchOpenLibraryWork } from '../../services/main/src/modules/source/open-library.ts';
import { projectOpenLibraryWork }
  from '../../services/main/src/modules/source/open-library-conversion.ts';

test('LIVE01/LIVE09: one current Open Library Work response is captured exactly', async () => {
  const workId = Bun.env.SOURCE_LIVE_WORK_ID ?? 'OL45804W';
  const result = await fetchOpenLibraryWork(workId);
  const bytes = Buffer.from(result.input.rawBytesBase64!, 'base64');
  const parsed = JSON.parse(bytes.toString('utf8')) as { key: string; title: string };
  expect(parsed.key).toBe(`/works/${workId}`);
  expect(parsed.title.length).toBeGreaterThan(0);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const projected = projectOpenLibraryWork({
    profile: 'source-acquisition-v1', state: 'staged',
    record: `https://rezics.com/id/${Bun.randomUUIDv7()}`,
    observation: `https://rezics.com/id/${Bun.randomUUIDv7()}`,
    ...result.input, byteDigest: digest, byteLength: bytes.length,
    submittedAt: new Date().toISOString(), capture: result.capture,
  });
  expect(projected.projection.title).toBe(parsed.title);
  expect(projected.fieldInventory).toHaveLength(Object.keys(parsed).length);
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const output = resolve(import.meta.dir, '../../.artifacts/source-live', runId);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, `${workId}.json`), bytes, { mode: 0o600 });
  writeFileSync(join(output, 'capture.json'), JSON.stringify({
    workId, byteDigest: digest, byteLength: bytes.length, capture: result.capture,
    sourceRevision: result.input.sourceRevision,
  }, null, 2), { mode: 0o600 });
  writeFileSync(join(output, 'conversion.json'), JSON.stringify(projected, null, 2),
    { mode: 0o600 });
  console.info(`Open Library ${workId}: ${bytes.length} bytes, sha256 ${digest}; ${output}`);
});

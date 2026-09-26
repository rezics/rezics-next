import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recentChangeIds } from '../../services/main/src/modules/source/acquisition-run.ts';
import { fetchOpenLibraryJson } from '../../services/main/src/modules/source/open-library.ts';

test('LIVE01/LIVE09/LIVE12: current Open Library run surfaces match the bounded run profile', async () => {
  const workId = Bun.env.SOURCE_LIVE_WORK_ID ?? 'OL45804W';
  const paths = { frontier: '/recentchanges.json?limit=10&offset=0', works: `/works/${workId}.json`,
    editions: `/works/${workId}/editions.json?limit=25&offset=0`, ratings: `/works/${workId}/ratings.json` };
  const output = resolve(import.meta.dir, '../../.artifacts/source-live',
    `${new Date().toISOString().replaceAll(':', '-')}-run-${randomUUID()}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const summary: Record<string, unknown> = {};
  for (const [surface, path] of Object.entries(paths)) {
    const result = await fetchOpenLibraryJson(path);
    if (!result.ok) throw new Error(`${surface}: ${result.outcome} ${result.reason} ${result.status}`);
    const parsed = result.parsed as Record<string, unknown>;
    if (surface === 'frontier') expect(recentChangeIds(parsed)?.length).toBe(10);
    if (surface === 'works') expect(parsed.key).toBe(`/works/${workId}`);
    if (surface === 'editions') {
      expect(Number.isSafeInteger(parsed.size)).toBe(true);
      expect((parsed.entries as unknown[]).every(entry => typeof (entry as { key?: unknown }).key === 'string')).toBe(true);
    }
    if (surface === 'ratings') expect(typeof parsed.summary).toBe('object');
    writeFileSync(join(output, `${surface}.json`), result.bytes, { mode: 0o600 });
    summary[surface] = { url: result.url, bytes: result.bytes.length, fetchedAt: result.fetchedAt,
      fields: Array.isArray(parsed) ? null : Object.keys(parsed).sort() };
    await Bun.sleep(1_100);
  }
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.info(JSON.stringify(summary));
}, 60_000);

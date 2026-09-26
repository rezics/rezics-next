import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest }
  from '../../../services/main/src/modules/work/edit.ts';
import { readExactWorkRevision } from '../../../services/main/src/modules/work/history.ts';
import { qaStack, requireFaultTier, rootCommand } from './search-ops-support.ts';

test('MODEL25: offline TDB2 compaction preserves exact old Work revision and identity', async () => {
  const { runId, artifacts } = requireFaultTier();
  const stack = qaStack(`${runId}-co`);
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stack.args], 180_000);
    const fuseki = stack.fuseki;
    const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!, routingEpoch: stack.apps.MAIN_ROUTING_EPOCH! };
    const env = { fuseki, lineage, objectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, lineage);
    const title = `Old exact state ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `compact-${randomUUID()}`, requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const nextTitle = `New current state ${randomUUID()}`;
    const edited = await editMetadataWork(env, { work: created.work, expectedHead: created.workRevision,
      title: nextTitle, admission: { id: randomUUID(), scope: `work:edit:${created.work}`,
        action: 'work.edit', requestDigest: metadataWorkEditDigest(created.work,
          created.workRevision, nextTitle), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const readOld = () => readExactWorkRevision(env, created.workRevision, async () => true);
    expect((await readOld()).title).toBe(title);

    const active = stack.compose(['run', '--rm', '--no-deps', '-T',
      '--entrypoint', '/usr/local/bin/tdb2-compact', 'fuseki'], 30_000);
    expect(active.status).toBe(75);
    stack.runner.stop();
    const generationCount = () => stack.runner.offline(
      'ls -d /fuseki/databases/rezics/tdb2/Data-*').split(/\r?\n/)
      .filter(line => /^\/fuseki\/databases\/rezics\/tdb2\/Data-[0-9]+$/.test(line.trim())).length;
    const before = generationCount();
    expect(before).toBeGreaterThan(0);
    const compacted = stack.compose(['run', '--rm', '--no-deps', '-T',
      '--entrypoint', '/usr/local/bin/tdb2-compact', 'fuseki'], 300_000);
    expect(compacted.status).toBe(0);
    const after = generationCount();
    expect(after).toBe(before + 1);
    const newestSize = () => {
      const output = stack.runner.offline(`latest=$(ls -d \
      /fuseki/databases/rezics/tdb2/Data-* | sort | tail -n 1)
      du -sk "$latest"`).trim();
      const size = /^(\d+)\s/.exec(output)?.[1];
      if (!size) throw new Error(`TDB2 generation size is unavailable: ${output}`);
      return Number(size);
    };
    const smallSize = newestSize();
    expect(smallSize).toBeGreaterThan(0);
    // The isolated QA copy has no recovery window. Remove only its inactive
    // generation while holding the same owner lock, then resolve old history.
    stack.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
      flock -n 9 || exit 75
      old=$(ls -d /fuseki/databases/rezics/tdb2/Data-* | sort | head -n 1)
      test -n "$old" && rm -r "$old"`);
    expect(generationCount()).toBe(before);
    await stack.runner.start();
    const exact = await readOld();
    expect(exact).toMatchObject({ revision: created.workRevision, work: created.work,
      title, sourcePosition: { dataEpoch: created.dataEpoch, sequence: created.sequence } });
    const current = await readExactWorkRevision(env, edited.revision, async () => true);
    expect(current).toMatchObject({ work: created.work, title: nextTitle });
    for (let index = 0; index < 4; index++) {
      const extraTitle = `Compaction scale ${index} ${randomUUID()}`;
      await activateMetadataWork(env, { title: extraTitle,
        admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
          idempotencyKey: `compact-scale-${randomUUID()}`,
          requestDigest: metadataWorkRequestDigest(extraTitle), authorityEpoch: '0',
          expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    stack.runner.stop();
    const scaled = stack.compose(['run', '--rm', '--no-deps', '-T',
      '--entrypoint', '/usr/local/bin/tdb2-compact', 'fuseki'], 300_000);
    expect(scaled.status).toBe(0);
    const scaledSize = newestSize();
    expect(scaledSize).toBeGreaterThanOrEqual(smallSize);
    expect(scaledSize).toBeLessThanOrEqual(smallSize * 8);
    await stack.runner.start();
    expect((await readOld()).title).toBe(title);
    writeFileSync(join(artifacts, 'tdb2-compact-history.json'), JSON.stringify({ runId,
      work: created.work, oldRevision: created.workRevision, newRevision: edited.revision,
      generationsBefore: before, generationsAfter: after,
      smallGenerationKiB: smallSize, scaledGenerationKiB: scaledSize,
      activeRefusal: active.status }, null, 2) + '\n');
  } finally {
    if (started) rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, 420_000);

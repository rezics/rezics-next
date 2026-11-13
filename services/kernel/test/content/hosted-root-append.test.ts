import { expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import readChain from '../../src/content/read-chain.sql';
import * as reads from '../../src/content/reads.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';
import { hostedAppendDescriptor } from '../../src/content/hosted-chapters-append.ts';
import type { HostedRootAppendInput } from '../../src/content/hosted-chapters-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { hostedRootAppendBase } from './support/hosted-root-append-setup.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

/** Native command details complement the mounted author API witness. */
test('native root append retains old drafts/releases, races heads, and replays exact receipts beyond 512', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  try {
    const { route, parameters, path, source, target, placements, created, published } = await hostedRootAppendBase(f);
    const migration = readFileSync(
      new URL('../../db/content/migrations/20261113025800_hosted_root_append.sql', import.meta.url),
      'utf8',
    );
    const oldRows = async () =>
      (
        await f.native.pool.query(
          `SELECT revision_id,occurrence_id,parent_id,position,ordinal,title,target_revision_id,body_sha256
       FROM content.hosted_placement WHERE route=$1 AND catalogue_id=$2 ORDER BY revision_id,ordinal`,
          parameters,
        )
      ).rows;
    const original = await oldRows();
    // Unused additive storage can be rolled back and installed again while
    // legacy drafts and publication pointers keep their original identities.
    await f.native.pool.query(migration.split('-- migrate:down')[1]!);
    await f.native.pool.query(migration.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    expect(await oldRows()).toEqual(original);
    const exactPath = `${path}/occurrences/${placements[511]!.occurrenceId}?revisionId=${published.revisionId}`;
    const exactBefore = await f.native.call('GET', exactPath, undefined, { anonymous: true });
    expect(exactBefore.status).toBe(200);
    const dependencies: HostedCommandDependencies = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(),
    };
    const append = (input: HostedRootAppendInput, key = crypto.randomUUID(), other = false) =>
      appendHostedRootChapter(
        dependencies,
        (other ? f.native.system.actors.other : f.native.author).actor,
        f.catalogueId,
        input,
        { idempotencyKey: key, deadline: Date.now() + 120_000, requestId: crypto.randomUUID() },
      );
    const input: HostedRootAppendInput = {
      expectedRevisionId: created.revisionId,
      occurrenceId: f.newOccurrenceId(),
      title: 'After the whole base',
      target,
    };
    await expect(append({ ...input, target: { ...target, sha256: '0'.repeat(64) } })).rejects.toThrow();
    const originalRead = reads.readPostMetadata;
    let changedSource = false;
    const retained = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
      const result = await originalRead(...args);
      if (args[2] === target.postId && !changedSource) {
        changedSource = true;
        expect((await f.native.revise(source.firstPost, {})).status).toBe(200);
      }
      return result;
    });
    try {
      await expect(append(input)).rejects.toThrow();
      expect(changedSource).toBe(true);
    } finally {
      retained.mockRestore();
    }
    expect(await hostedAppendDescriptor(f.native.pool, f.catalogueId, created.revisionId)).toBeNull();
    const assertBounded = (records: readonly SqlExecution[], first: boolean) => {
      const structural = records.filter((row) =>
        /FROM content.hosted_(placement|append_descriptor)/.test(row.statement),
      );
      expect(structural).toHaveLength(first ? 3 : 1);
      expect(structural.every((row) => !/COUNT\(|WITH RECURSIVE|OFFSET /i.test(row.statement))).toBe(true);
      const inserts = records.filter((row) => /INSERT INTO content.hosted_/.test(row.statement));
      expect(inserts.filter((row) => row.statement.includes('content.hosted_occurrence('))).toHaveLength(1);
      expect(inserts.filter((row) => row.statement.includes('content.hosted_append\n'))).toHaveLength(1);
      expect(inserts.filter((row) => row.statement.includes('content.hosted_append_descriptor'))).toHaveLength(
        first ? 2 : 1,
      );
      expect(inserts.some((row) => row.statement.includes('content.hosted_placement'))).toBe(false);
      // Native metadata admission may repeat retained source checks; it must
      // never select the manuscript bytes or validate earlier placements.
      const probes = records.filter((row) => row.statement === readChain.sql);
      expect(probes.length).toBeGreaterThan(0);
      expect(probes.filter((row) => row.parameters[readChain.params.indexOf('include_body')] === true)).toEqual([]);
    };
    const key = crypto.randomUUID();
    const start = observer.records.length;
    const nativeRead = reads.readPostMetadata;
    let targetObservations = 0;
    const probe = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
      targetObservations++;
      expect(args[1]).toBe(target.threadId);
      expect(args[2]).toBe(target.postId);
      expect(args[4]).toBe(target.revisionId);
      return nativeRead(...args);
    });
    const first = await append(input, key).finally(() => probe.mockRestore());
    expect(targetObservations).toBe(1);
    assertBounded(observer.records.slice(start), true);
    const descriptor = await hostedAppendDescriptor(f.native.pool, f.catalogueId, first.value.revisionId);
    expect(descriptor).toMatchObject({
      baseRevisionId: created.revisionId,
      basePlacementCount: 512n,
      baseRootCount: 497n,
      highWater: 0n,
    });
    expect(await hostedAppendDescriptor(f.native.pool, f.catalogueId, created.revisionId)).toMatchObject({
      revisionId: created.revisionId,
      baseRevisionId: created.revisionId,
      highWater: -1n,
    });
    expect(await oldRows()).toEqual(original);
    // The old immutable release still resolves through the unchanged manifest reader.
    expect((await f.native.call('GET', `${path}/children`, undefined, { anonymous: true })).value).toMatchObject({
      revisionId: published.revisionId,
      items: [{ occurrenceId: placements[511]!.occurrenceId }],
    });
    const makeNext = (): HostedRootAppendInput => ({
      ...input,
      expectedRevisionId: first.value.revisionId,
      occurrenceId: f.newOccurrenceId(),
    });
    const candidates = [makeNext(), makeNext()];
    const raceStart = observer.records.length;
    const race = await Promise.allSettled(candidates.map((candidate) => append(candidate)));
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = race.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason instanceof RevisionPreconditionError).toBe(true);
    assertBounded(observer.records.slice(raceStart), false);
    const winner = race.find((result) => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('Missing race winner');
    const head = winner.value.value.revisionId;
    expect(await append(input, key)).toMatchObject({ value: first.value, replayed: true });
    await expect(append({ ...input, title: 'Changed operands' }, key)).rejects.toThrow('Idempotency');
    await expect(append({ ...input, expectedRevisionId: head })).rejects.toThrow(
      'Occurrence identity cannot be reused',
    );
    await expect(append(input, key, true)).rejects.toThrow();
    const rows = (
      await f.native.pool.query(
        `SELECT append_offset::text,occurrence_id,target_revision_id,encode(body_sha256,'hex') AS digest
       FROM content.hosted_append WHERE route=$1 AND catalogue_id=$2 AND stream_id=$3 ORDER BY append_offset`,
        [...parameters, created.revisionId],
      )
    ).rows;
    expect(rows.map((row) => row.append_offset)).toEqual(['0', '1']);
    expect(rows.every((row) => row.target_revision_id === target.revisionId && row.digest === target.sha256)).toBe(
      true,
    );
    expect(await hostedAppendDescriptor(f.native.pool, f.catalogueId, first.value.revisionId)).toEqual(descriptor);
    expect(
      (
        await f.native.pool.query(
          'SELECT head_revision_id,publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2',
          parameters,
        )
      ).rows[0],
    ).toEqual({ head_revision_id: head, publication_id: published.revisionId });
    for (const table of ['hosted_append_descriptor', 'hosted_append']) {
      await expect(
        f.native.pool.query(
          `UPDATE content.${table} SET catalogue_id=catalogue_id WHERE route=$1 AND catalogue_id=$2`,
          parameters,
        ),
      ).rejects.toThrow('Hosted occurrence identities and snapshots are immutable');
    }
    await expect(f.native.pool.query(migration.split('-- migrate:down')[1]!)).rejects.toThrow(
      'Cannot roll back hosted append storage with retained append rows',
    );
    // Replacement keeps its original meaning: an explicit empty snapshot starts
    // a fresh stream; stale replacement and stale append remain precondition failures.
    expect(
      (await f.native.call('POST', `${path}:revise`, { expectedRevisionId: first.value.revisionId, placements: [] }))
        .status,
    ).toBe(412);
    const replacement = await f.native.command(`${path}:revise`, { expectedRevisionId: head, placements: [] }, 200);
    const afterReplacement = await append({
      ...input,
      expectedRevisionId: replacement.revisionId,
      occurrenceId: f.newOccurrenceId(),
    });
    expect(await hostedAppendDescriptor(f.native.pool, f.catalogueId, afterReplacement.value.revisionId)).toMatchObject(
      { baseRevisionId: replacement.revisionId, basePlacementCount: 0n, baseRootCount: 0n, highWater: 0n },
    );
    expect(await oldRows()).toEqual(original);
    expect((await f.native.call('GET', exactPath, undefined, { anonymous: true })).value).toEqual(exactBefore.value);
    await f.native.command(`/v1/posts/${f.catalogueId}:erase`, { reason: 'Withdraw catalogue authority' }, 200);
    await expect(append(input, key)).rejects.toThrow();
    expect((await f.native.call('POST', `${path}:append`, input)).status).toBe(404);
  } finally {
    await observer.close();
    await f.close();
  }
});

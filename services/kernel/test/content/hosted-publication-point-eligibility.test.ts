import { expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { prepareHostedPointPublicEligibility } from '../../src/content/hosted-publication-point-eligibility.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

test('point eligibility uses retained anonymous exact metadata for only public new sources', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  let restoreMetadata: (() => void) | undefined;
  try {
    const catalogue = await f.native.thread('published');
    await f.native.command('/v1/hostedCatalogues', {
      postId: catalogue.firstPost.id,
      threadId: catalogue.id,
      placements: [],
    });
    const chapter = await f.native.thread('published');
    const draft = await f.native.thread('draft');
    const openingTarget = f.target(catalogue);
    const chapterTarget = f.target(chapter);
    const draftTarget = f.target(draft);
    const deps = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      clock: () => new Date(),
    };
    const context = { actor: f.native.author.actor, deadline: Date.now() + 120_000 };
    const callerActors: string[] = [];
    const callerPosts: string[] = [];
    let mutating = false;
    let changeNextChapterRead = false;
    const nativeRead = reads.readPostMetadata;
    const metadata = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
      if (!mutating) {
        callerActors.push(args[3].actor.kind);
        callerPosts.push(args[2]);
      }
      const from = observer.records.length;
      const result = await nativeRead(...args);
      expect(
        observer.records
          .slice(from)
          .filter(
            (row) =>
              row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
          ),
      ).toHaveLength(0);
      if (changeNextChapterRead && args[2] === chapterTarget.postId) {
        changeNextChapterRead = false;
        mutating = true;
        try {
          expect((await f.native.revise(chapter.firstPost, {})).status).toBe(200);
        } finally {
          mutating = false;
        }
      }
      return result;
    });
    restoreMetadata = () => metadata.mockRestore();

    const callsBefore = callerActors.length;
    const prepared = await prepareHostedPointPublicEligibility(deps, openingTarget, [chapterTarget], context);
    expect(prepared).not.toBeNull();
    const selectedFinalStart = observer.records.length;
    expect(await prepared!.final()).toBe(true);
    expect(callerActors.slice(callsBefore)).toEqual(['anonymous', 'anonymous']);
    expect(callerPosts.slice(callsBefore).sort()).toEqual([openingTarget.postId, chapterTarget.postId].sort());
    expect(
      observer.records
        .slice(selectedFinalStart)
        .filter(
          (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
        ),
    ).toHaveLength(0);

    expect(await prepareHostedPointPublicEligibility(deps, openingTarget, [draftTarget], context)).toBeNull();
    expect(
      await prepareHostedPointPublicEligibility(deps, openingTarget, [await f.protectedChapter()], context),
    ).toBeNull();

    changeNextChapterRead = true;
    const changed = await prepareHostedPointPublicEligibility(deps, openingTarget, [chapterTarget], context);
    expect(changed).not.toBeNull();
    const changedFinalStart = observer.records.length;
    expect(await changed!.final()).toBe(false);
    expect(
      observer.records
        .slice(changedFinalStart)
        .filter(
          (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
        ),
    ).toHaveLength(0);
  } finally {
    restoreMetadata?.();
    await observer.close();
    await f.close();
  }
});

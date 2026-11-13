import { expect, setDefaultTimeout, test } from 'bun:test';
import { issueRevisionDisclosure, revokeRevisionDisclosure } from '../../src/content/revision-disclosure.ts';
import { prepareHostedPointDisclosureEligibility } from '../../src/content/hosted-publication-point-eligibility.ts';
import { InvalidHostedStructureError } from '../../src/content/hosted-chapters-model.ts';
import {
  selectHostedPublicationPoint,
  type HostedPointSelectionReads,
} from '../../src/content/hosted-publication-point-selection.ts';
import type { HostedChapterTarget, OrderedHostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

function commandContext() {
  return { idempotencyKey: crypto.randomUUID(), deadline: Date.now() + 120_000, requestId: crypto.randomUUID() };
}

const sourceTarget: HostedChapterTarget = {
  threadId: 'thread',
  postId: 'post',
  revisionId: 'revision-new',
  sha256: 'a'.repeat(64),
};

function part(occurrenceId: string, parentId: string | null = null): OrderedHostedPlacement {
  return { occurrenceId, parentId, position: 0, ordinal: 0, title: occurrenceId, kind: 'part' };
}

function chapter(occurrenceId: string, parentId: string | null, target: HostedChapterTarget): OrderedHostedPlacement {
  return { occurrenceId, parentId, position: 0, ordinal: 0, title: occurrenceId, kind: 'chapter', target };
}

function reads(
  draft: ReadonlyMap<string, OrderedHostedPlacement>,
  publication: ReadonlyMap<string, OrderedHostedPlacement>,
  counts: { draft: number; publication: number },
): HostedPointSelectionReads {
  return {
    async draftPoint(_revisionId, occurrenceId) {
      counts.draft += 1;
      return draft.get(occurrenceId) ?? null;
    },
    async publicationPoint(_publicationId, occurrenceId) {
      counts.publication += 1;
      return publication.get(occurrenceId) ?? null;
    },
  };
}

test('point insertion resolves every anchor in the selected public snapshot with bounded reads', async () => {
  const draft = new Map<string, OrderedHostedPlacement>([
    ['private-part', part('private-part')],
    ['new-chapter', chapter('new-chapter', 'private-part', sourceTarget)],
  ]);
  const publication = new Map<string, OrderedHostedPlacement>([
    ['public-part', part('public-part')],
    ['public-before', chapter('public-before', 'public-part', { ...sourceTarget, postId: 'other' })],
  ]);
  for (let index = 0; index < 3000; index += 1) publication.set(`unrelated-${index}`, part(`unrelated-${index}`));
  const counts = { draft: 0, publication: 0 };
  const selection = await selectHostedPublicationPoint(reads(draft, publication, counts), {
    kind: 'publishChapter',
    input: {
      expectedRevisionId: 'draft-head',
      expectedPublicationId: 'public-head',
      occurrenceId: 'new-chapter',
      target: sourceTarget,
      parentId: 'public-part',
      beforeOccurrenceId: 'public-before',
      selectedAncestors: [{ occurrenceId: 'private-part', beforeOccurrenceId: null }],
    },
  });

  expect(selection).toMatchObject({
    kind: 'publishChapter',
    parentId: 'public-part',
    beforeOccurrenceId: 'public-before',
    ancestors: [{ placement: { occurrenceId: 'private-part' } }],
    changedPlacements: [{ occurrenceId: 'new-chapter' }],
  });
  expect(counts).toEqual({ draft: 2, publication: 4 });
});

test('point insertion refuses a draft-only anchor or an omitted draft-only ancestor', async () => {
  const draft = new Map<string, OrderedHostedPlacement>([
    ['private-part', part('private-part')],
    ['draft-sibling', chapter('draft-sibling', null, { ...sourceTarget, postId: 'draft' })],
    ['new-chapter', chapter('new-chapter', 'private-part', sourceTarget)],
  ]);
  const publication = new Map<string, OrderedHostedPlacement>([['public-part', part('public-part')]]);
  const base = {
    expectedRevisionId: 'draft-head',
    expectedPublicationId: 'public-head',
    occurrenceId: 'new-chapter',
    target: sourceTarget,
    parentId: 'public-part',
    beforeOccurrenceId: null,
    selectedAncestors: [{ occurrenceId: 'private-part', beforeOccurrenceId: null }],
  } as const;

  await expect(
    selectHostedPublicationPoint(reads(draft, publication, { draft: 0, publication: 0 }), {
      kind: 'publishChapter',
      input: { ...base, beforeOccurrenceId: 'draft-sibling' },
    }),
  ).rejects.toBeInstanceOf(InvalidHostedStructureError);
  await expect(
    selectHostedPublicationPoint(reads(draft, publication, { draft: 0, publication: 0 }), {
      kind: 'publishChapter',
      input: { ...base, selectedAncestors: [] },
    }),
  ).rejects.toBeInstanceOf(InvalidHostedStructureError);
});

test('replacement keeps the exact public placement and selects only the requested draft target', async () => {
  const oldTarget = { ...sourceTarget, revisionId: 'revision-old', sha256: 'b'.repeat(64) };
  const draft = new Map<string, OrderedHostedPlacement>([
    ['chapter', chapter('chapter', 'draft-parent', sourceTarget)],
  ]);
  const publication = new Map<string, OrderedHostedPlacement>([
    ['chapter', { ...chapter('chapter', 'public-parent', oldTarget), position: 7, ordinal: 42, title: 'Public title' }],
  ]);
  const selection = await selectHostedPublicationPoint(reads(draft, publication, { draft: 0, publication: 0 }), {
    kind: 'replacePublishedChapter',
    input: {
      expectedRevisionId: 'draft-head',
      expectedPublicationId: 'public-head',
      occurrenceId: 'chapter',
      target: sourceTarget,
    },
  });

  expect(selection.kind).toBe('replacePublishedChapter');
  if (selection.kind !== 'replacePublishedChapter') throw new Error('Expected replacement selection');
  expect(selection.publicChapter).toMatchObject({
    parentId: 'public-parent',
    position: 7,
    ordinal: 42,
    title: 'Public title',
  });
  expect(selection.draftChapter.target).toEqual(sourceTarget);
  expect(selection.changedPlacements).toEqual([selection.draftChapter]);
});

test('point eligibility accepts exact private Book consent and rechecks revocation at commit', async () => {
  const f = await hostedChaptersFixture();
  try {
    const catalogue = await f.native.thread('published');
    const otherCatalogue = await f.native.thread('published');
    const privateOpening = await f.native.thread('draft');
    const target = f.target(privateOpening);
    const opening = f.target(catalogue);
    const deps = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(),
    };
    const context = { actor: f.native.author.actor, deadline: Date.now() + 120_000 };

    expect(
      await prepareHostedPointDisclosureEligibility(deps, opening, catalogue.firstPost.id, [target], context),
    ).toBeNull();
    const consent = await issueRevisionDisclosure(
      deps,
      f.native.author.actor,
      { catalogueId: catalogue.firstPost.id, target },
      commandContext(),
    );
    expect(
      await prepareHostedPointDisclosureEligibility(deps, opening, otherCatalogue.firstPost.id, [target], context),
    ).toBeNull();

    const prepared = await prepareHostedPointDisclosureEligibility(
      deps,
      opening,
      catalogue.firstPost.id,
      [target],
      context,
    );
    expect(prepared).not.toBeNull();
    const client = await f.native.pool.connect();
    try {
      expect(await prepared!.final(client)).toBe(true);
    } finally {
      client.release();
    }

    await revokeRevisionDisclosure(
      deps,
      f.native.author.actor,
      { disclosureId: consent.value.disclosureId },
      commandContext(),
    );
    const afterRevoke = await f.native.pool.connect();
    try {
      expect(await prepared!.final(afterRevoke)).toBe(false);
    } finally {
      afterRevoke.release();
    }
  } finally {
    await f.close();
  }
});

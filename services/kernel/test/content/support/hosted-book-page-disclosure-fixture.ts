import { fromPlainText } from '@rezics/document';
import type { PoolClient } from 'pg';
import { restrictPostRevision } from '../../../src/content/moderation.ts';
import { issueRevisionDisclosure, revokeRevisionDisclosure } from '../../../src/content/revision-disclosure.ts';
import { commitHostedVersionRevision } from '../../../src/content/hosted-version-revision.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
} from '../../../src/content/hosted-version-store.ts';
import type { HostedVersionPointValue } from '../../../src/content/hosted-version-draft-write.ts';
import type { HostedChapterTarget } from '../../../src/content/hosted-chapters-model.ts';
import type {
  VersionedOutlineSequenceNode,
  VersionedOutlineSequenceReadWriteSet,
} from '../../../src/content/versioned-outline-sequence.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { hostedChaptersFixture } from './hosted-chapters-fixture.ts';

type Item = Readonly<{ occurrenceId: string; title: string; target: HostedChapterTarget }>;

const commandContext = () => ({
  deadline: Date.now() + 120_000,
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
});

/** Use the fixture's real native Auth, Access and Content composition. */
export async function hostedBookPageDisclosureFixture() {
  const base = await hostedChaptersFixture();
  const { native } = base;
  const contentDependencies = {
    pool: native.pool,
    access: native.system.access,
    tokens: native.system.tokenKeys,
    routeKey: native.system.routeKey,
    clock: () => new Date(),
  };

  async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await native.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function tree(
    index: VersionedOutlineSequenceReadWriteSet<HostedVersionPointValue>,
    items: readonly Item[],
    start = 0,
    end = items.length,
    parentId: string | null = null,
  ): Readonly<{ rootId: string | null; height: number; count: bigint }> {
    if (start >= end) return { rootId: null, height: 0, count: 0n };
    const middle = Math.floor((start + end) / 2);
    const item = items[middle]!;
    const left = tree(index, items, start, middle, item.occurrenceId);
    const right = tree(index, items, middle + 1, end, item.occurrenceId);
    const node: VersionedOutlineSequenceNode<HostedVersionPointValue> = {
      id: item.occurrenceId,
      value: {
        kind: 'chapter',
        title: item.title,
        subtreeHeight: 0,
        chapterCount: 1n,
        target: item.target,
      },
      leftId: left.rootId,
      rightId: right.rootId,
      treeParentId: parentId,
      height: Math.max(left.height, right.height) + 1,
      count: left.count + right.count + 1n,
      chapterWeight: 1n,
      chapterCount: left.count + right.count + 1n,
    };
    index.writeNode(node);
    return { rootId: node.id, height: node.height, count: node.count };
  }

  async function seedVersion(
    catalogueId: string,
    items: readonly Item[],
    revisionKind: 'structure' | 'publication',
    expectedDraftRevisionId: string,
    expectedPublicationId: string | null = null,
  ): Promise<string> {
    const route = routeOf(catalogueId);
    if (route === null) throw new Error('Invalid hosted fixture catalogue route');
    const generationKind = revisionKind === 'structure' ? 'draft' : 'candidate';
    const revisionId = newId(route);
    const generationId = newId(route);
    return transaction(async (tx) => {
      const empty = await createHostedVersionGeneration(tx, catalogueId, generationId, generationKind);
      const write = createHostedVersionWrite<HostedVersionPointValue>(tx, empty);
      const siblingRoot = tree(hostedVersionSequence(write, 'sibling'), items).rootId;
      const preorderRoot = tree(hostedVersionSequence(write, 'preorder'), items).rootId;
      const chapterRoot = tree(hostedVersionSequence(write, 'chapter'), items).rootId;

      for (const item of items) {
        stageHostedVersionOccurrence(write, item.occurrenceId, {
          parentOccurrenceId: null,
          subtreeSize: 1n,
          value: {
            kind: 'chapter',
            title: item.title,
            subtreeHeight: 0,
            chapterCount: 1n,
            target: item.target,
          },
        });
      }
      stageHostedVersionSiblingRoot(write, null, siblingRoot);
      stageHostedVersionSnapshotRoots(write, {
        preorderRootId: preorderRoot,
        chapterRootId: chapterRoot,
        placementCount: BigInt(items.length),
        chapterCount: BigInt(items.length),
      });
      const snapshot = await commitHostedVersionWrite(tx, write);
      const receipt = {
        revisionId,
        recordedTransactionId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        expectedDraftRevisionId,
      };
      if (revisionKind === 'structure') {
        await commitHostedVersionRevision(tx, {
          ...receipt,
          revisionKind,
          snapshot: {
            route,
            catalogueId,
            generationId,
            generationKind: 'draft',
            sequence: snapshot.sequence,
          },
        });
      } else {
        await commitHostedVersionRevision(tx, {
          ...receipt,
          revisionKind,
          expectedPublicationId,
          snapshot: {
            route,
            catalogueId,
            generationId,
            generationKind: 'candidate',
            sequence: snapshot.sequence,
          },
        });
      }
      return revisionId;
    });
  }

  async function createBook(catalogueId: string, threadId: string, items: readonly Item[]) {
    const created = await native.command('/v1/hostedCatalogues', {
      postId: catalogueId,
      threadId,
      placements: items.map((item, position) => ({
        occurrenceId: item.occurrenceId,
        parentId: null,
        position,
        title: item.title,
        kind: 'chapter',
        target: item.target,
      })),
    });
    const draftRevisionId = await seedVersion(catalogueId, items, 'structure', created.revisionId as string);
    const publicationId = await seedVersion(catalogueId, items, 'publication', draftRevisionId);
    return { draftRevisionId, publicationId };
  }

  const sourceBody = fromPlainText('Private source A');
  const targetAThread = await native.thread('draft', sourceBody);
  const targetBThread = await native.thread('draft', fromPlainText('Private source B'));
  const targetA = base.target(targetAThread);
  const targetB = base.target(targetBThread);
  const route = routeOf(base.catalogueId)!;
  const originalItems: readonly Item[] = [
    { occurrenceId: newId(route), title: 'Consented private chapter', target: targetA },
    { occurrenceId: newId(route), title: 'Consented duplicate chapter', target: targetA },
    { occurrenceId: newId(route), title: 'Unconsented chapter', target: targetB },
  ];
  const initial = await createBook(base.catalogueId, base.threadId, originalItems);
  const consent = await issueRevisionDisclosure(
    contentDependencies,
    native.author.actor,
    { catalogueId: base.catalogueId, target: targetA },
    commandContext(),
  );

  const otherCatalogue = await native.thread('published', fromPlainText('Other catalogue'));
  const otherRoute = routeOf(otherCatalogue.firstPost.id)!;
  const otherItem: Item = {
    occurrenceId: newId(otherRoute),
    title: 'Same target in another Book',
    target: targetA,
  };
  const other = await createBook(otherCatalogue.firstPost.id, otherCatalogue.id, [otherItem]);

  return {
    native,
    catalogueId: base.catalogueId,
    path: `/v1/hostedCatalogues/${base.catalogueId}`,
    targetA,
    targetB,
    sourceBody,
    items: originalItems,
    draftRevisionId: initial.draftRevisionId,
    publicationId: initial.publicationId,
    other: {
      catalogueId: otherCatalogue.firstPost.id,
      publicationId: other.publicationId,
      occurrenceId: otherItem.occurrenceId,
    },
    disclosureId: consent.value.disclosureId,
    async moveDraftAndPublish() {
      const moved: readonly Item[] = [
        { ...originalItems[2]!, title: 'Moved unconsented chapter' },
        { ...originalItems[1]!, title: 'Moved duplicate title' },
        { ...originalItems[0]!, title: 'Moved private title' },
      ];
      const movedDraftRevisionId = await seedVersion(base.catalogueId, moved, 'structure', initial.draftRevisionId);
      const publicationId = await seedVersion(
        base.catalogueId,
        moved,
        'publication',
        movedDraftRevisionId,
        initial.publicationId,
      );
      return publicationId;
    },
    async reissueConsent() {
      return issueRevisionDisclosure(
        contentDependencies,
        native.author.actor,
        { catalogueId: base.catalogueId, target: targetA },
        commandContext(),
      );
    },
    async revokeConsent(disclosureId: string) {
      return revokeRevisionDisclosure(contentDependencies, native.author.actor, { disclosureId }, commandContext());
    },
    async hardRestrict(target: HostedChapterTarget) {
      return restrictPostRevision(
        {
          pool: native.pool,
          access: native.system.access,
          routeKey: native.system.routeKey,
          clock: () => new Date(),
        },
        native.system.actors.moderator.actor,
        { postId: target.postId, revisionId: target.revisionId, mode: 'hard', reason: 'Current read restriction' },
        commandContext(),
      );
    },
    close: base.close,
  };
}

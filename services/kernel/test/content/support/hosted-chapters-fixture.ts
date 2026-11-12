import { fromPlainText } from '@rezics/document';
import type { CloudEvent } from '../../../src/events/log.ts';
import { createSubjectThreadEffect } from '../../../src/content/subject-thread-index.ts';
import type { HostedChapterTarget } from '../../../src/content/hosted-chapters-model.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { postPublicationFixture, type PublicationPost } from './post-publication-fixture.ts';

type ThreadPost = { id: string; firstPost: PublicationPost };

/** Reuse ordinary Post creation and its real native Access/publication path. */
export async function hostedChaptersFixture() {
  const native = await postPublicationFixture();
  try {
    const catalogue = await native.thread();
    const route = routeOf(catalogue.firstPost.id);
    if (route === null) throw new Error('Hosted fixture catalogue has no route');

    const target = (thread: ThreadPost): HostedChapterTarget => {
      const post = thread.firstPost as PublicationPost & { sha256: string };
      return { threadId: thread.id, postId: post.id, revisionId: post.revisionId, sha256: post.sha256 };
    };
    const commandKeyOutsidePartition = (excluded: number, operation: string) => {
      for (let attempt = 0; attempt < 256; attempt++) {
        const key = `hosted-discovery-${crypto.randomUUID()}`;
        const identity = `${native.author.actor.accountId}\n${operation}\n${key}`;
        if (partitionOf(anchorRoute(native.system.routeKey, identity)) !== excluded) return key;
      }
      throw new Error('Could not choose a hosted discovery route outside the excluded partition');
    };
    async function subjectOutsidePartition(excludedPartition: number): Promise<string> {
      const { subject: scheme } = await native.command('/v1/subjects', {
        type: 'skos:ConceptScheme',
        labels: { en: 'Hosted discovery' },
      });
      const key = commandKeyOutsidePartition(excludedPartition, 'subject.create');
      const expectedRoute = anchorRoute(
        native.system.routeKey,
        `${native.author.actor.accountId}\nsubject.create\n${key}`,
      );
      const created = await native.call(
        'POST',
        '/v1/subjects',
        {
          type: 'skos:Concept',
          labels: { en: `Hosted discovery ${crypto.randomUUID()}` },
          statements: {
            'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
          },
        },
        { key },
      );
      if (created.status !== 201) throw new Error(`Hosted discovery Subject creation failed (${created.status})`);
      const id = created.value.id as string;
      if (routeOf(id) !== expectedRoute) throw new Error('Hosted discovery Subject did not use its selected route');
      if (partitionOf(routeOf(id)!) === excludedPartition)
        throw new Error('Hosted discovery Subject did not use its selected partition');
      return id;
    }
    async function threadOutsidePartition(excludedPartition: number): Promise<ThreadPost> {
      const key = commandKeyOutsidePartition(excludedPartition, 'content.thread.create');
      const expectedRoute = anchorRoute(
        native.system.routeKey,
        `${native.author.actor.accountId}\ncontent.thread.create\n${key}`,
      );
      const created = await native.call(
        'POST',
        '/v1/threads',
        {
          title: 'Hosted discovery catalogue',
          body: fromPlainText('Catalogue post'),
          licence: 'MIT',
          subjectIds: [],
          boardId: native.board.id,
          visibility: 'published',
        },
        { key },
      );
      if (created.status !== 201) throw new Error(`Hosted discovery thread creation failed (${created.status})`);
      const thread = created.value.thread as ThreadPost;
      if (routeOf(thread.id) !== expectedRoute)
        throw new Error('Hosted discovery thread did not use its selected route');
      return thread;
    }
    async function projectSubjectThread(threadId: string): Promise<void> {
      const sourceTypes = [
        'com.rezics.content.thread.created.v1',
        'com.rezics.content.post.created.v1',
        'com.rezics.content.revision.created.v1',
      ];
      const events = await native.pool.query<{
        partition_no: number;
        epoch: number;
        position: string;
        id: string;
        type: string;
        subject: string;
        data: Record<string, unknown>;
        recorded_at: Date;
      }>(
        `SELECT partition_no,epoch,position::text,id::text,type,subject::text,data,recorded_at
         FROM core.outbox WHERE type=ANY($1::text[]) AND data->>'threadId'=$2
         ORDER BY position,event_seq`,
        [sourceTypes, threadId],
      );
      const effect = createSubjectThreadEffect(native.pool);
      for (const row of events.rows) {
        await effect.run({
          specversion: '1.0',
          id: row.id,
          source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
          type: row.type,
          subject: row.subject,
          time: row.recorded_at.toISOString(),
          datacontenttype: 'application/json',
          sequence: row.position.padStart(19, '0'),
          data: row.data,
        } as CloudEvent);
      }
    }
    return {
      native,
      catalogueId: catalogue.firstPost.id,
      threadId: catalogue.id,
      newOccurrenceId: () => newId(route),
      newOccurrenceIdFor: (id: string) => newId(routeOf(id)!),
      subjectOutsidePartition,
      threadOutsidePartition,
      projectSubjectThread,
      target,
      async protectedChapter() {
        const created = await native.command('/v1/threads', {
          title: 'Protected source',
          body: fromPlainText('Protected chapter'),
          licence: 'MIT',
          subjectIds: [],
          boardId: native.board.id,
          visibility: 'protected',
        });
        return target(created.thread as ThreadPost);
      },
      close: native.close,
    };
  } catch (error) {
    await native.close();
    throw error;
  }
}

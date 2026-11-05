import { answerFakeRoute, type FakeRoute } from '../fake-modules';
import collection from '../recorded/library-collection.json';
import members from '../recorded/library-collection-members.json';

export const collectionReadStoryIds = {
  mixed: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7be1',
  preparing: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7be2',
  unavailable: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7be3',
  error: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7be4',
  hidden: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7be5',
} as const;

/** Settled read responses only; no added write handlers or successful social-action fixtures. */
export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/viewerActions',
    story: async ({ request, recordings }) => {
      const body = (await request.json()) as { resources: { type: string; id: string }[] };
      if (!body.resources.every((resource) => resource.type === 'library.collection')) return;
      const resources = await Promise.all(
        body.resources.map(async ({ type, id }) => {
          const result = await answerFakeRoute(
            'story',
            new Request(`${new URL(request.url).origin}/v1/collections/${encodeURIComponent(id)}`, {
              headers: request.headers,
            }),
            recordings,
          );
          if (!result || result.status !== 200 || !result.collection || typeof result.collection !== 'object')
            return { type, id, error: 'not_found' };
          const owner =
            request.headers.has('authorization') &&
            'curatorAccountId' in result.collection &&
            result.collection.curatorAccountId === 'story-viewer';
          return {
            type,
            id,
            viewerActions: owner
              ? [
                  {
                    action: 'collection:update',
                    operations: ['collection.update', 'collection_member.create', 'collection_member.move'],
                  },
                  { action: 'collection:delete', operations: ['collection.delete'] },
                ]
              : [],
          };
        }),
      );
      return { status: 200, resources };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/([^/]+)(\/members)?$/,
    story: ({ match }) => {
      const id = match?.[1];
      const scenario = Object.entries(collectionReadStoryIds).find(([, value]) => value === id)?.[0];
      if (!id || !scenario) return;
      if (scenario === 'hidden') return { status: 404, code: 'not_found' };
      if (scenario === 'error') return { status: 500, code: 'internal_error' };
      if (!match?.[2])
        return {
          status: 200,
          collection: {
            ...collection.collection,
            id,
            curatorAccountId: 'story-viewer',
            title: 'A collection across many kinds of work',
            memberCount: 4,
            presentationKind: null,
            presentationKindSource: 'pending',
            cover: null,
            coverSource: 'pending',
          },
        };
      if (scenario === 'preparing') return { status: 202, preparing: true };
      if (scenario === 'unavailable') return { status: 503, code: 'dependency_unavailable' };
      const types = ['schema:Book', 'schema:Movie', 'schema:MusicAlbum', 'schema:Recipe'];
      return {
        status: 200,
        next: null,
        members: members.members.map((member, index) => ({
          ...member,
          subject: member.subject
            ? {
                ...member.subject,
                cover: null,
                type: types[index],
                types: [types[index]],
                label: {
                  ...member.subject.label,
                  value: `${member.subject.label.value} — a long title that stays attached to its own image across two lines`,
                },
              }
            : null,
        })),
      };
    },
  },
];

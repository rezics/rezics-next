import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { FakeRoute } from '../fake-modules';
import recording from '../recorded/library-collection-members.json';

// Illustrative continuation responses, not recordings or proof of native Library behavior.
export const memberContinuationTarget = { account: 'member-continuation' };
export const memberContinuationDocument = {
  root: { props: {} },
  content: [
    {
      type: 'Members',
      props: {
        id: 'members',
        title: {
          en: 'Books',
          'zh-Hans': '书籍',
          'zh-Hant': '書籍',
          ja: '本',
          ko: '책',
          fr: 'Livres',
          de: 'Bücher',
          es: 'Libros',
        },
        source: { kind: 'everything' },
        limit: 12,
        paged: true,
      },
    },
    {
      type: 'Members',
      props: {
        id: 'other-members',
        title: {
          en: 'Other books',
          'zh-Hans': '其他书籍',
          'zh-Hant': '其他書籍',
          ja: 'ほかの本',
          ko: '다른 책',
          fr: 'Autres livres',
          de: 'Weitere Bücher',
          es: 'Otros libros',
        },
        source: { kind: 'everything' },
        limit: 12,
        paged: true,
      },
    },
  ],
} satisfies CompositionDocument;
export const memberContinuationInitial = { members: recording.members.slice(0, 1), next: 'member-next' };

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const input = (await request.json()) as {
        target?: { account?: string };
        continuation?: { node: string; cursor: string };
      };
      if (input.target?.account !== memberContinuationTarget.account) return;
      const continuation = input.continuation;
      if (!continuation || !['members', 'other-members'].includes(continuation.node)) return { status: 400 };
      const { node, cursor } = continuation;
      const body =
        node === 'other-members'
          ? { members: [], next: cursor === 'member-next' ? 'other-end' : null }
          : cursor === 'member-next'
            ? { members: [recording.members[0], recording.members[1], recording.members[1]], next: 'member-duplicates' }
            : cursor === 'member-duplicates'
              ? { members: [recording.members[1]], next: 'member-empty-end' }
              : { members: [], next: null };
      const plan = planReads(platformRegistry, memberContinuationDocument, { subject: null, continuation });
      return {
        status: 200,
        document: memberContinuationDocument,
        reads: { [plan.nodes[node]!]: { status: 200, body } },
      };
    },
  },
];

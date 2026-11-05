import { expect, spyOn, test } from 'bun:test';
import { platformRegistry } from '@rezics/composition';
import { agentTitle } from '../src/features/pages/agent';
import { agentPageHead, type AgentPage } from '../src/features/pages/agent-page';

test('account titles and share identity use only a matching successful public projection', () => {
  // The current platform deduplicates AccountIdentity; vary its code-owned read to exercise ordering.
  const identity = platformRegistry.components.find((component) => component.type === 'AccountIdentity')!;
  const read = spyOn(identity, 'read').mockImplementation(({ id }) => ({ kind: 'account', handle: id }));
  try {
    for (const displayName of ['Shown Name', '']) {
      for (const status of [200, 403, 503]) {
        for (const order of [
          ['other', 'failed', 'shown'],
          ['shown', 'other', 'failed'],
        ]) {
          const page: AgentPage = {
            subject: null,
            account: { id: 'shown-id', handle: 'shown' },
            profile: 'platform',
            template: { scope: 'generic', key: null },
            document: { root: { props: {} }, content: order.map((id) => ({ type: 'AccountIdentity', props: { id } })) },
            reads: Object.fromEntries(
              order.map((id, index) => [
                `r${index}`,
                {
                  status: id === 'failed' ? 403 : id === 'shown' ? status : 200,
                  body: {
                    accounts: [
                      {
                        id: id === 'other' ? 'other-id' : 'shown-id',
                        state: 'active',
                        handle: id,
                        displayName: id === 'shown' ? displayName : 'Other Name',
                        kind: 'organization',
                        links: [{ label: 'Website', url: `https://example.test/${id}` }],
                      },
                    ],
                  },
                },
              ]),
            ),
          };
          const matching = status === 200;
          const name = matching && displayName ? displayName : 'shown';
          const head = agentPageHead(page, 'en', 'https://rezics.test');
          const graph = JSON.parse(head.scripts.find((script) => script.type === 'application/ld+json')!.children);
          expect(agentTitle(page)).toBe(matching && displayName ? displayName : '@shown');
          expect(head.meta).toContainEqual({ title: `${name} (@shown) – REZICS` });
          expect(head.meta).toContainEqual({ property: 'profile:username', content: 'shown' });
          expect(head.links).toContainEqual({ rel: 'canonical', href: 'https://rezics.test/en/@shown' });
          expect(graph['@graph'][0]).toMatchObject({ name: `${name} (@shown)`, url: 'https://rezics.test/en/@shown' });
          expect(graph['@graph'][0].mainEntity).toEqual({
            '@type': matching ? 'Organization' : 'Person',
            name,
            alternateName: 'shown',
            url: 'https://rezics.test/en/@shown',
            ...(matching ? { sameAs: ['https://example.test/shown'] } : {}),
          });
        }
      }
    }
  } finally {
    read.mockRestore();
  }
});

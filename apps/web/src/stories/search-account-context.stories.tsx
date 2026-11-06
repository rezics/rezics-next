import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { discoveryExample } from '../kernel/fake/search-discovery';
import { getLocale } from '../paraglide/runtime.js';
import { SearchResultsRegion } from '../search/search-regions/results';
import { AccountFollowControl } from '../search/account-context/follow';
import { discoveryKey, type DiscoveryPage } from '../search/discovery';
const reader = '01a1a000-0000-7000-8000-001000000011';
const subject = '01a1a000-0000-7000-8000-003000000013';
function Example({
  signedIn,
  writable,
  pending,
  concealed,
}: {
  signedIn: boolean;
  writable: boolean;
  pending: boolean;
  concealed: boolean;
}) {
  const page: DiscoveryPage = {
    ...discoveryExample,
    hits: discoveryExample.hits.filter((hit) => hit.summary.kind !== 'account'),
  };
  for (const [index, handle] of ['mira_reader', 'mira_bot', null].entries()) {
    const id = `01a1a000-0000-7000-8000-00200000001${index}`;
    page.hits.push({
      key: { owner: 'accounts', kind: 'account', route: 32, id },
      summary: {
        kind: 'account',
        value: {
          id,
          accountKind: 'actor',
          handle,
          displayName: 'Mira',
          automated: index === 1,
          operatorId: index === 1 ? reader : null,
          avatar: null,
          verifiedAgent: index === 0 ? { id: subject, label: 'Mira, author', type: 'schema:Person' } : null,
          context: {
            biography:
              concealed || !handle
                ? { state: 'withheld' }
                : {
                    state: 'available',
                    text: index
                      ? 'Automated reading notices operated by the library.'
                      : 'Reader and author. Public notes on books, languages and shared reading.',
                    truncated: false,
                  },
            followTarget:
              index === 0
                ? {
                    state: 'available',
                    id: subject,
                    label: 'Mira, author',
                    type: 'schema:Person',
                    source: 'a'.repeat(64),
                  }
                : { state: 'unavailable' },
          },
        },
      },
    });
  }
  const regionRef = useRef<HTMLElement | null>(null);
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-8">
      <SearchResultsRegion
        query="Mira"
        locale={getLocale()}
        selectedFacets={{}}
        data={{
          discovery: { status: 'ready', page },
          queryState: { query: 'Mira', facets: {}, type: undefined, cursor: undefined, sort: undefined },
          sort: 'relevance',
          hitTypes: {},
          yearProperties: [],
          typeChoices: [],
          groups: [],
          selectedFacetLabels: {},
          facetRetry: false,
          facetIndexNotReady: false,
          staleCursorRestarted: false,
        }}
        personal={{
          regionRef,
          recoveryView: null,
          renderPersonal: (hit) => {
            const target = hit.summary.kind === 'account' ? hit.summary.value.context?.followTarget : undefined;
            return signedIn && target?.state === 'available' ? (
              <AccountFollowControl
                key={discoveryKey(hit)}
                row={{
                  targetId: target.id,
                  targetType: 'subject',
                  source: target.source,
                  following: false,
                  actions: { follow: writable, unfollow: writable },
                }}
                binding={{ expectedReader: reader, expectedCredential: 'story-reader' }}
                lifetime="story-page"
                current={() => true}
                locale={getLocale()}
                rowKey={discoveryKey(hit)}
                write={async () => (pending ? new Promise(() => {}) : { ok: true, following: true })}
              />
            ) : (
              <></>
            );
          },
        }}
      />
    </div>
  );
}
const meta = {
  title: 'Patterns/Discovery/Account context',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: { signedIn: false, writable: true, pending: false, concealed: false },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const HomonymsAndNativeDestinations: Story = {};
export const CurrentViewer: Story = { args: { signedIn: true } };
export const MissingWriteScope: Story = { args: { signedIn: true, writable: false } };
export const ConcealedBiography: Story = { args: { concealed: true } };
export const PendingFollow: Story = { args: { signedIn: true, pending: true } };

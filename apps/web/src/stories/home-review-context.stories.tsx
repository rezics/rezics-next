import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeFeed } from '../features/pages/home-feed';
import { homeReviewContextPage } from '../kernel/fake/home-review-context';
import { getLocale } from '../paraglide/runtime.js';

function ReviewContext({
  parent = 'available',
  signedOut = false,
  retry = false,
}: {
  parent?: 'available' | 'withheld' | 'removed';
  signedOut?: boolean;
  retry?: boolean;
}) {
  const [client] = useState(() => new QueryClient());
  const [account, setAccount] = useState(0);
  const [retried, setRetried] = useState(false);
  const result = useMemo(() => ({ state: 'ready' as const, page: homeReviewContextPage(parent) }), [parent, account]);
  return (
    <QueryClientProvider client={client}>
      <div className="space-y-4 p-4">
        <p role="note">
          Prepared Content responses for Home reading. Native access, advice and eligibility are not demonstrated.
        </p>
        <button
          className="min-h-11 underline"
          onClick={() => {
            client.setQueryData(['session'], {
              state: 'signed-in',
              subject: `prepared-${account + 1}`,
              csrfToken: 'prepared-csrf',
            });
            setAccount(account + 1);
          }}
        >
          Replace prepared account
        </button>
        <HomeFeed
          locale={getLocale()}
          signedIn={!signedOut}
          result={retry && !retried ? { state: 'unavailable', code: 'dependency_unavailable' } : result}
          onRetry={() => setRetried(true)}
        />
      </div>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Pages/Discovery/Home review context (prepared)',
  component: ReviewContext,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReviewContext>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const ConcealedParent: Story = { args: { parent: 'withheld' } };
export const RemovedParent: Story = { args: { parent: 'removed' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const Retry: Story = { args: { retry: true } };

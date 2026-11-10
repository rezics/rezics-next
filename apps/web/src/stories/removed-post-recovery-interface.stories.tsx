import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { useRef, useState } from 'react';
import { LocaleProvider } from '@rezics/ui/locale';
import { Button } from '@rezics/ui/shadcn/button';
import type { PageAuthors } from '../identity/read';
import accounts from '../kernel/recorded/accounts.json';
import recorded from '../kernel/recorded/thread-posts.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { RemovedPost } from '../threads/post-removed';
import type { ThreadPost } from '../threads/reads';
import { ExistingReviewNotice, SignInPrompt } from '../threads/write-prompts';

const source = recorded.posts[0]!;
const authorId = source.authorId;
const deadline = '2099-11-23T03:04:05.000Z';
const reviewId = '0192f3a0-6c1e-7b2a-9d4e-000000000061';
const decisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000062/reference?appeal=read';
const reference = 'reference-'.repeat(24);
const failure = `The supplied restoration result is unavailable. ${reference}`;
const returnTo = `/de/threads/${source.threadId}/lesezeichen?reference=${reference}#post-${source.id}`;
const longLabel = 'Melden Sie sich an, um zu Ihrem gespeicherten Diskussionsbeitrag zurückzukehren. '.repeat(3);
const authors = Object.fromEntries(accounts.accounts.map((account) => [account.id, account])) as PageAuthors;

function erased(index: number, restorableUntil?: string): ThreadPost {
  const post = recorded.posts[index]!;
  return {
    id: post.id,
    threadId: post.threadId,
    route: post.route,
    parentId: post.parentId,
    availability: 'erased',
    removed: true,
    body: null,
    sha256: null,
    ...(restorableUntil === undefined ? {} : { restorableUntil }),
  };
}

const withheld: ThreadPost = {
  ...source,
  visibility: 'published',
  availability: 'withheld',
  removed: true,
  body: null,
  sha256: null,
  decisionId,
};

/** Only the supplied callbacks are simulated; this example makes no reads or writes. */
function RecoveryInterface() {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [restores, setRestores] = useState([0, 0]);
  const [refreshes, setRefreshes] = useState([0, 0]);
  const [copies, setCopies] = useState([0, 0]);
  const common = { authors, now: '2026-11-02T00:00:00.000Z', itemRef: null, menuButton: null };
  const count = (values: number[], index: number) => values.map((value, at) => value + Number(at === index));

  return (
    <LocaleProvider locale={getLocale()}>
      <main className="mx-auto min-w-0 max-w-2xl space-y-8 px-4 py-8">
        <h1 className="text-2xl font-semibold">Removed post recovery and write prompts</h1>
        <section aria-labelledby="recovery-author-heading" className="min-w-0 space-y-3">
          <h2 id="recovery-author-heading" className="text-lg font-medium">
            Author: independent recovery controls
          </h2>
          <ol className="min-w-0 space-y-4">
            <RemovedPost
              {...common}
              post={erased(0, deadline)}
              viewerId={authorId}
              anchorId="recovery-author"
              minHeight={320}
              restoreError={error}
              existingReviewId={error ? reviewId : undefined}
              onCopyLink={() => setCopies((values) => count(values, 0))}
              onRestore={() => {
                if (pendingRef.current) return;
                pendingRef.current = true;
                setPending(true);
                setRestores((values) => count(values, 0));
              }}
              onRefresh={() => setRefreshes((values) => count(values, 0))}
            />
            <RemovedPost
              {...common}
              post={erased(1)}
              viewerId={authorId}
              anchorId="recovery-clock-unknown"
              minHeight={280}
              deadlineUnknown
              restoreError={failure}
              existingReviewId={reviewId}
              onCopyLink={() => setCopies((values) => count(values, 1))}
              onRestore={() => setRestores((values) => count(values, 1))}
              onRefresh={() => setRefreshes((values) => count(values, 1))}
            />
          </ol>
          <p role="status" data-testid="recovery-observations" className="[overflow-wrap:anywhere]">
            {`Restore calls ${restores.join(', ')}; refresh calls ${refreshes.join(', ')}; copy calls ${copies.join(', ')}. ${pending ? 'Request pending.' : 'No request pending.'}`}
          </p>
          <Button
            variant="outline"
            disabled={!pending}
            className="h-auto min-h-11 whitespace-normal py-2"
            onClick={() => {
              pendingRef.current = false;
              setPending(false);
              setError(failure);
            }}
          >
            Return the supplied failure
          </Button>
        </section>
        <section aria-labelledby="recovery-other-heading">
          <h2 id="recovery-other-heading" className="text-lg font-medium">
            Another reader: deleted post
          </h2>
          <ol>
            <RemovedPost
              {...common}
              post={erased(2)}
              viewerId="another-reader"
              anchorId="recovery-nonowner"
              onCopyLink={() => {}}
            />
          </ol>
        </section>
        <section aria-labelledby="recovery-withheld-heading">
          <h2 id="recovery-withheld-heading" className="text-lg font-medium">
            Withheld: author and another reader
          </h2>
          <ol className="space-y-4">
            <RemovedPost
              {...common}
              post={withheld}
              viewerId={authorId}
              anchorId="recovery-withheld-owner"
              onCopyLink={() => {}}
            />
            <RemovedPost
              {...common}
              post={withheld}
              viewerId="another-reader"
              anchorId="recovery-withheld-reader"
              onCopyLink={() => {}}
            />
          </ol>
        </section>
        <section
          aria-labelledby="recovery-prompts-heading"
          className="min-w-0 space-y-4"
          data-testid="recovery-prompts"
        >
          <h2 id="recovery-prompts-heading" className="text-lg font-medium">
            Long localized write prompts
          </h2>
          <SignInPrompt returnTo={returnTo} label={longLabel} />
          <SignInPrompt compact returnTo={returnTo} label={'登入後返回這篇討論並繼續閱讀與回覆。'.repeat(12)} />
          <ExistingReviewNotice reviewId={reviewId} />
        </section>
      </main>
    </LocaleProvider>
  );
}

const meta = {
  title: 'Community/Removed post recovery',
  id: 'interfaces-community-removed-post-recovery',
  component: RecoveryInterface,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Actual RemovedPost and write prompts derived from the installed thread-posts/accounts recordings. Deadlines and admitted decision/review hints are illustrative supplied fields. Erased examples retain only native tombstone fields; callbacks simulate supplied pending and failure outcomes without requests. Observe Canonical with en/zh-Hans and phone390/desktop1280 globals. New interaction, geometry, focus, privacy and physical observations are UNRUN; native authorization and request lifetimes remain owed.',
      },
    },
  },
} satisfies Meta<typeof RecoveryInterface>;
export default meta;
type Story = StoryObj<typeof meta>;

// Authored observations only: browser, geometry, keyboard and physical review remain UNRUN.
export const Canonical: Story = {
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const owner = canvasElement.querySelector<HTMLLIElement>('#recovery-author')!;
    const unknown = canvasElement.querySelector<HTMLLIElement>('#recovery-clock-unknown')!;
    const other = canvasElement.querySelector<HTMLLIElement>('#recovery-nonowner')!;
    const withheldOwner = canvasElement.querySelector<HTMLLIElement>('#recovery-withheld-owner')!;
    const withheldReader = canvasElement.querySelector<HTMLLIElement>('#recovery-withheld-reader')!;
    const restore = within(owner).getByRole('button', { name: m.thread_post_restore() });
    const secondRestore = within(unknown).getByRole('button', { name: m.thread_post_restore() });
    const refresh = within(unknown).getByRole('button', { name: m.thread_post_refresh() });
    const more = within(owner).getByRole('button', { name: m.thread_content_more_actions() });
    const result = canvas.getByTestId('recovery-observations');
    const finish = canvas.getByRole('button', { name: 'Return the supplied failure' });

    await expect(finish).toBeDisabled();
    await expect(owner.querySelector('time')).toHaveAttribute('datetime', deadline);
    await expect(unknown).toHaveTextContent(m.thread_post_restore_deadline_unknown());
    await expect(unknown.querySelector('time')).toBeNull();
    await expect(other.querySelector('button')).toBeNull();
    await expect(withheldOwner).toHaveTextContent('Mira Okabe');
    await expect(withheldOwner.querySelector('time')).toHaveAttribute('datetime', source.createdAt);
    await expect(within(withheldOwner).getByRole('link', { name: m.thread_post_decision_link() })).toHaveAttribute(
      'href',
      `/moderation/decisions/${encodeURIComponent(decisionId)}`,
    );
    await expect(withheldReader.querySelector('a[href^="/moderation/"]')).toBeNull();
    await expect(canvas.getByTestId('recovery-prompts').querySelector('a')).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
    );

    await userEvent.keyboard('{Tab}');
    for (const control of [
      restore,
      secondRestore,
      refresh,
      more,
      ...canvas.getByTestId('recovery-prompts').querySelectorAll<HTMLAnchorElement>('a'),
      ...withheldOwner.querySelectorAll<HTMLAnchorElement>('a[href^="/moderation/"]'),
    ]) {
      const rect = control.getBoundingClientRect();
      await expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(rect.height).toBeGreaterThanOrEqual(44);
      control.focus();
      await expect(control).toHaveFocus();
      await expect(Number.parseFloat(getComputedStyle(control).outlineWidth)).toBeGreaterThanOrEqual(2);
    }
    for (const element of [owner, unknown, canvas.getByTestId('recovery-prompts')]) {
      await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    }
    await expect(owner.getBoundingClientRect().height).toBeGreaterThanOrEqual(320);
    await userEvent.click(restore);
    await userEvent.click(restore);
    await expect(result).toHaveTextContent('Restore calls 1, 0');
    await expect(result).toHaveTextContent('Request pending.');
    await userEvent.click(refresh);
    await expect(result).toHaveTextContent('refresh calls 0, 1');
    await userEvent.click(secondRestore);
    await expect(result).toHaveTextContent('Restore calls 1, 1');
    await userEvent.click(finish);
    await expect(finish).toBeDisabled();
    await expect(within(owner).getByRole('alert')).toHaveTextContent(failure);
    await expect(within(owner).getByRole('link', { name: m.thread_review_existing() })).toHaveAttribute(
      'href',
      `/${getLocale()}/threads/${reviewId}`,
    );
    await userEvent.click(within(owner).getByRole('button', { name: m.thread_post_refresh() }));
    await expect(result).toHaveTextContent('refresh calls 1, 1');
    await expect(owner.querySelector('[data-slot="tombstone"]')).not.toBeNull();
    await userEvent.click(more);
    await userEvent.click(await screen.findByText(m.thread_content_copy_link(), { exact: true }));
    await expect(result).toHaveTextContent('copy calls 1, 0');
    await waitFor(() =>
      expect(within(owner).getByRole('button', { name: m.thread_content_more_actions() })).toHaveFocus(),
    );
    owner.focus();
    await expect(owner).toHaveFocus();
    await expect(owner).toHaveAttribute('tabindex', '-1');
    await expect(canvasElement.querySelector('details')).toBeNull();
    for (const privateText of ['Flight notes', 'Watch the baobabs', 'The rose was unique']) {
      await expect(canvasElement.textContent).not.toContain(privateText);
      for (const element of canvasElement.querySelectorAll('*')) {
        for (const attribute of element.attributes) await expect(attribute.value).not.toContain(privateText);
      }
    }
  },
};

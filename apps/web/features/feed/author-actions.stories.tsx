import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { Button } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { chooseMenuItem } from '../stories/choose-option.ts';
import { ThreadView } from '../realm/thread-view.tsx';
import { AuthorActions } from './author-actions.tsx';
import { authorFixture as f, authorTarget, authorTransport } from './author-fixtures.ts';
import { authorMessages } from './author-messages.ts';
import { DiscussionCard, type DiscussionPost } from './discussion-card.tsx';
import { FeedProvider } from './feed-context.tsx';
import { messages } from './messages.ts';
import { communityHref, threadPath } from './discussion.ts';
import { memoryThreads, storyRealm, storyThread, THREAD_NOW } from './thread-fixtures.ts';

type Options = Parameters<typeof authorTransport>[0];
interface Props { locale?: UiLocale; options?: Options; signedIn?: boolean; foreign?: boolean }

function Objects({ locale = 'en', options, signedIn = true, foreign = false }: Props) {
  const [transport] = useState(() => authorTransport(options));
  const [generation, setGeneration] = useState(0);
  return <main className="mx-auto grid max-w-2xl gap-5 p-4 sm:p-8">
    <h1 className="text-xl font-semibold">Rain at the station</h1>
    <article aria-label="Opening post" className="grid gap-3 border-b border-border pb-4">
      <header className="flex items-center gap-2"><p className="me-auto text-sm font-medium">Mei · 10 minutes ago</p>
        <AuthorActions key={generation} target={authorTarget} actingSubject={foreign ? f.other : f.actor}
          signedIn={signedIn} locale={locale} signInHref="/auth/start?next=%2Fen"
          api={transport.api} />
      </header>
      <p lang="en">{f.body}</p>
    </article>
    <article aria-label="Another author’s reply" className="ms-4 grid gap-3 border-s border-border ps-4">
      <header className="flex items-center gap-2"><p className="me-auto text-sm font-medium">Ari · 5 minutes ago</p>
        <AuthorActions target={{ ...authorTarget, reply: f.other, author: f.other }} actingSubject={f.actor}
          signedIn={signedIn} locale={locale} signInHref="/auth/start?next=%2Fen" api={transport.api} />
      </header>
      <p lang="en">This reply belongs to someone else.</p>
    </article>
    <Button variant="outline" onClick={() => setGeneration(value => value + 1)}>Reopen object</Button>
    <output aria-label="Mutation count" className="sr-only">{transport.calls.filter(call => call.method === 'POST').length}</output>
  </main>;
}

function SelectedObject({ locale = 'en' }: { locale?: UiLocale }) {
  const [transport] = useState(() => authorTransport({ publishedCorrected: true, draftAhead: true }));
  const [updated, setUpdated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const target = { ...authorTarget, placement: updated ? f.latestPlacement : f.nextPlacement,
    revisionId: updated ? f.nextCorrected : f.corrected };
  return <main className="mx-auto grid max-w-2xl gap-5 p-4 sm:p-8">
    <article className="grid gap-3 border-b border-border pb-4">
      <header className="flex items-center gap-2"><p className="me-auto text-sm font-medium">Mei · Rain at the station</p>
        <AuthorActions key={generation} target={target} actingSubject={f.actor} signedIn locale={locale}
          signInHref="/auth/start?next=%2Fen" api={transport.api} onChanged={() => setUpdated(true)} />
      </header>
      <p lang="en">{f.correctedBody}{updated ? ' Another published correction.' : ''}</p>
    </article>
    <Button variant="outline" onClick={() => setGeneration(value => value + 1)}>Reload selected object</Button>
  </main>;
}

const meta = {
  title: 'Feed/Author actions', component: Objects,
  beforeEach() { localStorage.clear(); },
  parameters: { route: { pathname: localizedPath(threadPath(communityHref(f.realm), f.reply), 'en') } },
} satisfies Meta<typeof Objects>;
export default meta;
type Story = StoryObj<typeof meta>;

async function open(canvasElement: HTMLElement, action: 'edit' | 'placement' = 'edit', locale: UiLocale = 'en') {
  const t = authorMessages[locale];
  await userEvent.click(within(canvasElement).getByRole('button', { name: t.menu }));
  await chooseMenuItem(within(document.body), 'menuitem', t[action]);
  const dialog = within(await within(document.body).findByRole('dialog'));
  if (action === 'edit') await dialog.findByRole('textbox', { name: t.body });
  else await waitFor(() => expect(dialog.getByRole('button', { name: t.withdraw })).toBeEnabled());
  return dialog;
}

// Contenteditable selection uses the same browser Range/paste path as the chapter stories.
async function append(editor: HTMLElement, text: string) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await userEvent.paste(text);
  await waitFor(() => expect(editor).toHaveTextContent(text.trim()));
}

export const OwnedAndForeign: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('button', { name: authorMessages.en.menu })).toHaveLength(1);
    await expect(within(within(canvasElement).getByRole('article', { name: 'Another author’s reply' }))
      .queryByRole('button', { name: authorMessages.en.menu })).not.toBeInTheDocument();
  },
};

export const NormalPostMenus: Story = {
  render: () => {
    const post: DiscussionPost = { kind: 'discussion', href: threadPath(communityHref(f.realm), f.reply),
      vote: { id: f.placement, vote: 0, score: 3, revision: null, open: false },
      realm: null, author: { id: f.actor, name: 'Mei', handle: null }, authorTarget,
      time: '2026-09-28T12:00:00Z', title: 'Rain at the station', body: f.body,
      language: 'en', work: null, comments: { value: 1, kind: 'exact' } };
    return <FeedProvider locale="en" messages={messages} now={Date.parse('2026-09-28T13:00:00Z')}
      signedIn actingSubject={f.actor} signInHref="/auth/start?next=%2Fen" avatarQuery="" tab="all" followedRealms={null}>
      <main className="mx-auto max-w-2xl py-4">
        <DiscussionCard post={post} />
        <DiscussionCard post={{ ...post, kind: 'reply', href: `${post.href}/reply`, title: null,
          author: { id: f.other, name: 'Ari', handle: null }, authorTarget: { ...authorTarget, author: f.other } }} />
      </main>
    </FeedProvider>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('button', { name: authorMessages.en.menu })).toHaveLength(1);
    const trigger = canvas.getByRole('button', { name: authorMessages.en.menu });
    const rect = trigger.getBoundingClientRect();
    await expect(trigger.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))).toBe(true);
    await userEvent.click(trigger);
    await expect(await within(document.body).findByRole('menuitem', { name: authorMessages.en.edit })).toBeVisible();
    await expect(within(document.body).getByRole('menuitem', { name: authorMessages.en.placement })).toBeVisible();
  },
};

export const NestedReplyMenus: Story = {
  render: () => {
    const actor = storyThread.items[1]!.author!.id;
    const href = threadPath(storyRealm.path, storyThread.focus);
    return <FeedProvider locale="en" messages={messages} now={THREAD_NOW} signedIn actingSubject={actor}
      signInHref="/auth/start?next=%2Fen" avatarQuery="" tab="all" followedRealms={null}>
      <main className="mx-auto max-w-3xl p-4"><ThreadView read={storyThread} realm={storyRealm}
        sort="best" sortHrefs={{ best: href, new: `${href}?sort=new`, top: `${href}?sort=top` }}
        replyMode="open" threadApi={memoryThreads()} /></main>
    </FeedProvider>;
  },
  async play({ canvasElement }) {
    const t = authorMessages.en;
    const triggers = within(canvasElement).getAllByRole('button', { name: t.menu });
    await expect(triggers).toHaveLength(2);
    for (const trigger of triggers) await expect(trigger.closest('article')).toHaveTextContent('Daniel Chen');
    const trigger = triggers[0]!;
    await userEvent.click(trigger);
    const menuElement = await within(document.body).findByRole('menu');
    await waitFor(() => expect(menuElement).toHaveFocus());
    const menu = within(menuElement);
    await expect(menu.getByRole('menuitem', { name: t.edit })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: t.placement })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const ForeignObject: Story = {
  args: { foreign: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('button', { name: authorMessages.en.menu })).not.toBeInTheDocument();
  },
};

export const Visitor: Story = {
  args: { signedIn: false },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('button', { name: authorMessages.en.menu })).not.toBeInTheDocument();
  },
};

export const Correction: Story = {
  async play({ canvasElement }) {
    const dialog = await open(canvasElement);
    const editor = dialog.getByRole('textbox', { name: authorMessages.en.body });
    await append(editor, ' Corrected wording.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.corrected);
    await userEvent.click(dialog.getByText(authorMessages.en.close, { selector: 'button' }));
    await waitFor(() => expect(within(canvasElement).getByRole('button', { name: authorMessages.en.menu })).toHaveFocus());
  },
};

export const CancelAndReopen: Story = {
  async play({ canvasElement }) {
    let dialog = await open(canvasElement);
    const editor = dialog.getByRole('textbox', { name: authorMessages.en.body });
    await append(editor, ' Keep these unpublished words.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.cancel }));
    await waitFor(() => expect(within(canvasElement).getByRole('button', { name: authorMessages.en.menu })).toHaveFocus());
    const memory = JSON.parse(localStorage.getItem(`rezics:author-correction:v1:${f.actor}:${f.realm}:${f.reply}`)!);
    await expect(memory.correction).toBeNull();
    await expect(memory.body).toContain('Keep these unpublished words.');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reopen object' }));
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('textbox', { name: authorMessages.en.body })).toHaveTextContent('Keep these unpublished words.');
  },
};

export const RetryAfterReload: Story = {
  args: { options: { fail: 'place' } },
  async play({ canvasElement }) {
    let dialog = await open(canvasElement);
    await append(dialog.getByRole('textbox', { name: authorMessages.en.body }), ' Retain this correction.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.failed);
    const key = `rezics:author-correction:v1:${f.actor}:${f.realm}:${f.reply}`;
    const pending = JSON.parse(localStorage.getItem(key)!);
    await expect(pending.correction.saved.revisionId).toBe(f.corrected);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.cancel }));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reopen object' }));
    dialog = await open(canvasElement);
    await expect(dialog.getByRole('textbox', { name: authorMessages.en.body })).toHaveTextContent('Retain this correction.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.retry }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.corrected);
    await expect(localStorage.getItem(key)).toBeNull();
  },
};

export const StaleCorrection: Story = {
  args: { options: { fail: 'draft', status: 409, code: 'stale_head' } },
  async play({ canvasElement }) {
    const dialog = await open(canvasElement);
    await append(dialog.getByRole('textbox', { name: authorMessages.en.body }), ' My correction survives.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.stale);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.reload }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.latest);
    await expect(dialog.getByRole('textbox', { name: authorMessages.en.body })).toHaveTextContent('My correction survives.');
    await waitFor(() => expect(dialog.getByRole('button', { name: authorMessages.en.save })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(await dialog.findByText(authorMessages.en.corrected)).toBeVisible();
    await waitFor(() => expect(dialog.getByRole('button', { name: authorMessages.en.close })).toHaveFocus());
  },
};

async function selectedHeadRecovery(canvasElement: HTMLElement, locale: UiLocale = 'en') {
  const t = authorMessages[locale];
  let dialog = await open(canvasElement, 'edit', locale);
  await expect(dialog.getByRole('textbox', { name: t.body })).toHaveTextContent(f.correctedBody);
  await expect(dialog.getByRole('textbox', { name: t.body })).not.toHaveTextContent('Private unpublished draft.');
  await append(dialog.getByRole('textbox', { name: t.body }), ' Another published correction.');
  await userEvent.click(dialog.getByRole('button', { name: t.save }));
  await expect(await dialog.findByText(t.corrected)).toBeVisible();
  await waitFor(() => expect(dialog.getByRole('button', { name: t.close })).toHaveFocus());
  await userEvent.click(dialog.getByRole('button', { name: t.close }));
  await waitFor(() => expect(within(canvasElement).getByRole('button', { name: t.menu })).toHaveFocus());
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reload selected object' }));
  dialog = await open(canvasElement, 'edit', locale);
  await expect(dialog.getByRole('textbox', { name: t.body })).toHaveTextContent('Another published correction.');
}

export const SelectedHeadRecovery: Story = {
  render: () => <SelectedObject />,
  async play({ canvasElement }) { await selectedHeadRecovery(canvasElement); },
};

export const SelectedHeadRecoveryPhone: Story = {
  render: () => <SelectedObject locale="zh-Hans" />,
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans', theme: 'dark' },
  async play({ canvasElement }) { await selectedHeadRecovery(canvasElement, 'zh-Hans'); },
};

export const WithdrawPlacement: Story = {
  async play({ canvasElement }) {
    const dialog = await open(canvasElement, 'placement');
    await expect(dialog.getByText(authorMessages.en.placementHelp)).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.withdraw }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.placementWithdrawn);
  },
};

export const RetryWithdrawal: Story = {
  args: { options: { fail: 'withdraw' } },
  async play({ canvasElement }) {
    const dialog = await open(canvasElement, 'placement');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.withdraw }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.failed);
    await expect(dialog.getByRole('button', { name: authorMessages.en.retry })).toBeEnabled();
  },
};

export const ExpiredSession: Story = {
  args: { options: { fail: 'draft', status: 401 } },
  async play({ canvasElement }) {
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.signIn);
    await expect(dialog.getByRole('link', { name: authorMessages.en.signInAction })).toBeVisible();
  },
};

export const KeyboardRetry: Story = {
  args: { options: { fail: 'draft' } },
  async play({ canvasElement }) {
    const t = authorMessages.en;
    const trigger = within(canvasElement).getByRole('button', { name: t.menu });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const menu = await within(document.body).findByRole('menu');
    await waitFor(() => expect(menu).toHaveFocus());
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: t.edit })).toHaveAttribute('data-highlighted'));
    await userEvent.keyboard('{Enter}');
    const dialog = within(await within(document.body).findByRole('dialog', { name: t.edit }));
    await dialog.findByRole('textbox', { name: t.body });
    const save = dialog.getByRole('button', { name: t.save });
    save.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await dialog.findByRole('alert')).toHaveTextContent(t.failed);
    await waitFor(() => expect(dialog.getByRole('button', { name: t.retry })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(await dialog.findByRole('status')).toHaveTextContent(t.corrected);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const PermissionRevoked: Story = {
  args: { options: { fail: 'draft', status: 403 } },
  async play({ canvasElement }) {
    const dialog = await open(canvasElement);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.denied);
    await expect(dialog.queryByRole('button', { name: authorMessages.en.retry })).not.toBeInTheDocument();
  },
};

export const PhoneChinese: Story = {
  args: { locale: 'zh-Hans' }, globals: { viewport: { value: 'phone' }, locale: 'zh-Hans' },
  async play({ canvasElement }) { await open(canvasElement, 'edit', 'zh-Hans'); },
};

export const DarkWithdrawal: Story = {
  globals: { theme: 'dark' },
  async play({ canvasElement }) { await open(canvasElement, 'placement'); },
};

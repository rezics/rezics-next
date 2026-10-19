import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { Button } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { AuthorActions } from './author-actions.tsx';
import { authorFixture as f, authorTarget, authorTransport } from './author-fixtures.ts';
import { authorMessages } from './author-messages.ts';

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

const meta = {
  title: 'Feed/Author actions', component: Objects,
  beforeEach() { localStorage.clear(); },
  parameters: { route: { pathname: '/en/r/fiction/discussions/author-post' } },
} satisfies Meta<typeof Objects>;
export default meta;
type Story = StoryObj<typeof meta>;

async function open(canvasElement: HTMLElement, action: 'edit' | 'placement' = 'edit', locale: UiLocale = 'en') {
  const t = authorMessages[locale];
  await userEvent.click(within(canvasElement).getByRole('button', { name: t.menu }));
  await userEvent.click(await within(document.body).findByRole('menuitem', { name: t[action] }));
  const dialog = within(await within(document.body).findByRole('dialog'));
  if (action === 'edit') await dialog.findByRole('textbox', { name: t.body });
  else await waitFor(() => expect(dialog.getByRole('button', { name: t.withdraw })).toBeEnabled());
  return dialog;
}

export const OwnedAndForeign: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('button', { name: authorMessages.en.menu })).toHaveLength(1);
    await expect(within(within(canvasElement).getByRole('article', { name: 'Another author’s reply' }))
      .queryByRole('button', { name: authorMessages.en.menu })).not.toBeInTheDocument();
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
    await userEvent.click(editor);
    await userEvent.keyboard('{End}');
    await userEvent.type(editor, ' Corrected wording.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.corrected);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.close }));
    await waitFor(() => expect(within(canvasElement).getByRole('button', { name: authorMessages.en.menu })).toHaveFocus());
  },
};

export const CancelAndReopen: Story = {
  async play({ canvasElement }) {
    let dialog = await open(canvasElement);
    const editor = dialog.getByRole('textbox', { name: authorMessages.en.body });
    await userEvent.type(editor, ' Keep these unpublished words.');
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
    await userEvent.type(dialog.getByRole('textbox', { name: authorMessages.en.body }), ' Retain this correction.');
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
    await userEvent.type(dialog.getByRole('textbox', { name: authorMessages.en.body }), ' My correction survives.');
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.save }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.stale);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.reload }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.latest);
    await expect(dialog.getByRole('textbox', { name: authorMessages.en.body })).toHaveTextContent('My correction survives.');
  },
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

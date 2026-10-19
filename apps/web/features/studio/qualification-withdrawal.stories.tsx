import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { Button } from '@rezics/ui/button';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { authorFixture as f } from '../feed/author-fixtures.ts';
import { authorMessages } from '../feed/author-messages.ts';
import type { ChapterPublication } from './content-api.ts';
import { ChapterEditor } from './chapter-editor.tsx';
import { agents, chapterOpened } from './fixtures.ts';
import { messages } from './messages.ts';

function PublishedChapter({ fail = false, locale = 'en' }: { fail?: boolean; locale?: UiLocale }) {
  const [generation, setGeneration] = useState(0);
  const [current, setCurrent] = useState<ChapterPublication>({ publication: f.placement, eligibility: f.nextPlacement });
  const [main] = useState(() => {
    let missed = false;
    return browserMainApi('https://author.invalid', { fetcher: Object.assign(async () => {
      if (fail && !missed) { missed = true; return Response.json({ code: 'unavailable' }, { status: 503 }); }
      setCurrent({ publication: f.placement, eligibility: f.withdrawal });
      return Response.json({ profile: 'content-search-eligibility-withdrawal-v1', outcome: 'succeeded',
        resourceId: f.reply, variantId: f.variant, publicationDecision: f.placement, withdrawnEligibilityHead: f.nextPlacement,
        decision: f.withdrawal, receipt: 'urn:rezics:receipt:author-withdrawal', graphDataEpoch: 'fixture', graphSequence: '4', replayed: missed });
    }, { preconnect: fetch.preconnect }) });
  });
  const chapter = chapterOpened('末班车到站时，整座站台只有她一个人。', f.revision);
  return <main>
    <ChapterEditor key={generation} agent={{ ...agents[0]!, iri: f.actor }}
      book={{ id: f.root, title: { value: '雨夜书店', language: 'zh-Hans' } }}
      chapter={{ ...chapter, chapter: { ...chapter.chapter, id: f.reply }, variant: f.variant,
        publication: current.publication, eligibility: current.eligibility }}
      locale={locale} messages={messages} main={main} />
    <div className="p-4"><Button variant="outline" onClick={() => setGeneration(value => value + 1)}>Reopen chapter</Button></div>
  </main>;
}
const meta = {
  title: 'Studio/Published chapter withdrawal', component: PublishedChapter,
  beforeEach() { localStorage.clear(); },
} satisfies Meta<typeof PublishedChapter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Cancel: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: authorMessages.en.qualification });
    await userEvent.click(button);
    const dialog = within(await within(document.body).findByRole('dialog'));
    await expect(dialog.getByText(authorMessages.en.qualificationHelp)).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.cancel }));
    await waitFor(() => expect(button).toHaveFocus());
    await expect(localStorage.getItem(`rezics:qualification-withdrawal:v1:${f.actor}:${f.reply}:${f.variant}`)).toBeNull();
  },
};

export const WithdrawAndReload: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement), t = authorMessages.en;
    await userEvent.click(canvas.getByRole('button', { name: t.qualification }));
    let dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: t.withdraw }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(t.qualificationWithdrawn);
    await userEvent.click(dialog.getByText(t.close, { selector: 'button' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen chapter' }));
    await userEvent.click(canvas.getByRole('button', { name: t.qualification }));
    dialog = within(await within(document.body).findByRole('dialog'));
    await expect(dialog.getByRole('status')).toHaveTextContent(t.qualificationWithdrawn);
    await expect(dialog.queryByRole('button', { name: t.withdraw })).not.toBeInTheDocument();
  },
};

export const Retry: Story = {
  args: { fail: true },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: authorMessages.en.qualification }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.withdraw }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(authorMessages.en.failed);
    await userEvent.click(dialog.getByRole('button', { name: authorMessages.en.retry }));
    await expect(await dialog.findByRole('status')).toHaveTextContent(authorMessages.en.qualificationWithdrawn);
  },
};

export const PhoneChineseDark: Story = {
  args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' }, theme: 'dark' },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: authorMessages['zh-Hans'].qualification }));
    await within(document.body).findByRole('dialog');
  },
};

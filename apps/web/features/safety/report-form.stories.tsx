import { resourceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ReportForm } from './report-form.tsx';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000101';
const realm = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000e1';

let sent: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
let reply: () => Response = () => Response.json({ profile: 'public-report-v1', reportId: 'r', caseId: 'c', receivedAt: '2026-10-01T00:00:00.000Z',
  credential: 'A'.repeat(43), replayed: false }, { status: 201 });
const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
  sent.push({ url: String(input), key: new Headers(init?.headers).get('idempotency-key'),
    body: JSON.parse(String(init?.body)) });
  return reply();
}) as typeof fetch;

const meta = {
  title: 'Safety/Report form',
  component: ReportForm,
  parameters: { route: { pathname: '/en/report' } },
  args: { locale: 'en', target, send },
  beforeEach() {
    sent = [];
    reply = () => Response.json({ profile: 'public-report-v1', reportId: 'r', caseId: 'c', receivedAt: '2026-10-01T00:00:00.000Z',
      credential: 'A'.repeat(43), replayed: false }, { status: 201 });
  },
  render: args => <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6"><ReportForm {...args} /></div>,
} satisfies Meta<typeof ReportForm>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The plain categories need only a statement; no declarations, and the email stays optional. */
export const Harassment: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Harassment or bullying/ }));
    await expect(canvas.queryByText('Removal request')).toBeNull();
    await expect(canvas.queryByText('Copyright notice')).toBeNull();
    await expect(canvas.getByText('Optional. We use it only to tell you about this report.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await expect(await canvas.findByText('Describe the problem.')).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'What is wrong?' })).toHaveFocus();
    await userEvent.type(canvas.getByRole('textbox', { name: 'What is wrong?' }), 'Repeated abuse in the replies.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await expect(sent[0]!.url).toBe('/api/main/v1/public-reports');
    // The interface is English, but nothing says the statement is: the language stays unspecified until chosen.
    await expect(sent[0]!.body).toMatchObject({ profile: 'public-report-v1', target, category: 'harassment',
      contentLanguage: 'und' });
    await expect(sent[0]!.body.ncii).toBeUndefined();
  },
};

/** NCII shows the no-image instruction and the 48-hour notice, and needs the declarations and a contact. */
export const NonConsensualImages: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Intimate images shared without consent/ }));
    await expect(canvas.getByText(/Do not upload or email the image/)).toBeVisible();
    await expect(canvas.getByText(/no later than 48 hours after we receive it/)).toBeVisible();
    await expect(canvas.queryByLabelText(/image file/i)).toBeNull();
    await expect(canvas.queryByRole('button', { name: /upload/i })).toBeNull();
    await expect(canvas.getByText('Required for this kind of report, so we can reach you safely.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    // Each problem is on its own field, and focus goes to the first in reading order.
    await expect(await canvas.findAllByText('Tick this statement to continue.')).toHaveLength(2);
    await expect(await canvas.findAllByText('Fill this in.')).toHaveLength(2);
    await expect(canvas.getByRole('checkbox', { name: /I am the person shown/ })).toHaveFocus();
    await expect(canvas.getByRole('checkbox', { name: /I am the person shown/ })).toBeInvalid();
    await expect(sent).toHaveLength(0);

    await userEvent.click(canvas.getByRole('checkbox', { name: /I am the person shown/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /without the consent of the person shown/ }));
    await userEvent.type(canvas.getByRole('textbox', { name: /What makes you believe this/ }), 'It was posted by my former partner.');
    await userEvent.type(canvas.getByRole('textbox', { name: /Signature/ }), 'Ada Lovelace');
    await userEvent.type(canvas.getByRole('textbox', { name: 'What is wrong?' }), 'Please remove it.');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Contact email' }), 'ada@example.com');
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await expect(sent[0]!.body).toMatchObject({ category: 'ncii', contactEmail: 'ada@example.com',
      ncii: { signature: 'Ada Lovelace', depictedPersonOrAuthorized: true, goodFaithWithoutConsent: true,
        supportingInformation: 'It was posted by my former partner.' } });
  },
};

/** The child-safety guidance comes before anything is typed: never copy the material, call for help, NCMEC. */
export const ChildSafety: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Before you report')).toBeNull();
    await userEvent.click(canvas.getByRole('radio', { name: /Child sexual exploitation/ }));
    await expect(canvas.getByRole('heading', { name: 'Before you report' })).toBeVisible();
    await expect(canvas.getByText(/Do not download, copy, re-upload or send the material/)).toBeVisible();
    await expect(canvas.getByText(/Give us its location and a brief description instead/)).toBeVisible();
    await expect(canvas.getByText('If a child may be in immediate danger, contact local emergency services.')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /NCMEC CyberTipline/ }))
      .toHaveAttribute('href', 'https://www.ncmec.org/gethelpnow/cybertipline');
    await expect(canvas.queryByLabelText(/image file/i)).toBeNull();
    await expect(canvasElement.querySelector('input[type=file]')).toBeNull();
  },
};

/** A credible threat reminds the reporter to call emergency services. */
export const CredibleThreat: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Credible threat of harm/ }));
    await expect(canvas.getByText('If someone may be in immediate danger, contact local emergency services.')).toBeVisible();
    await expect(canvas.queryByText('Before you report')).toBeNull();
  },
};

/** A copyright notice is a sworn statement: every element and both statements, and a contact. */
export const CopyrightNotice: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /^Copyright/ }));
    await expect(canvas.getByRole('heading', { name: 'Copyright notice' })).toBeVisible();
    await expect(canvas.getByText(/legal statement made under penalty of perjury/)).toBeVisible();
    for (const [name, value] of [['Your full name', 'Ada Lovelace'], ['Postal address', '1 Analytical Way'],
      ['Phone number', '+44 20 7946 0000'], ['The work you say was copied', 'The Rain Bookshop'],
      ['Where the copy is on REZICS', resourceHref('/w/', '00000001-4b5a-4c6d-8e7f-9a0b1c2d3e4f')], ['Signature (type your full name)', 'Ada Lovelace'],
      ['What is wrong?', 'This is my novel.'], ['Contact email', 'ada@example.com']] as const) {
      await userEvent.type(canvas.getByRole('textbox', { name }), value);
    }
    await userEvent.click(canvas.getByRole('checkbox', { name: /not authorized by the owner/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /under penalty of perjury that this notice is accurate/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await expect(sent[0]!.body).toMatchObject({ category: 'copyright', copyright: { claimantName: 'Ada Lovelace',
      goodFaith: true, accurateAndAuthorizedUnderPerjury: true } });
  },
};

/** Realm rules appear only where a Realm is reported, and send that Realm. */
export const RealmRules: Story = {
  args: { realm },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Breaks this community’s rules/ }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'What is wrong?' }), 'Off-topic.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await expect(sent[0]!.body).toMatchObject({ category: 'realm_rules', realm });
  },
};

/** Without a Realm the category is not offered. */
export const NoRealmRules: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('radio', { name: /Breaks this community’s rules/ })).toBeNull();
  },
};

/** A lost response and a second press send the same key; a changed report gets a new one. */
export const RetryKeepsTheKey: Story = {
  async play({ canvasElement }) {
    reply = () => new Response(null, { status: 503 });
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Spam or manipulation/ }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'What is wrong?' }), 'Spam.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('could not be sent'));
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    await expect(sent[1]!.key).toBe(sent[0]!.key);
    await userEvent.type(canvas.getByRole('textbox', { name: 'What is wrong?' }), ' More spam.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(sent).toHaveLength(3));
    await expect(sent[2]!.key).not.toBe(sent[0]!.key);
  },
};

/** A spent report budget says when to try again. */
export const RateLimited: Story = {
  async play({ canvasElement }) {
    reply = () => new Response(null, { status: 429, headers: { 'retry-after': '900' } });
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Spam or manipulation/ }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'What is wrong?' }), 'Spam.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('try again in 15 minutes'));
  },
};

/** Every word is in the reader's language. */
export const TraditionalChinese: Story = {
  args: { locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /未經同意散布的私密影像/ }));
    await expect(canvas.getByText(/最遲在收到後 48 小時內完成/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: '送出檢舉' })).toBeVisible();
  },
};

/** The child-safety guidance is in the reader's language. */
export const ChildSafetyJapanese: Story = {
  args: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /児童への性的搾取/ }));
    await expect(canvas.getByText(/ダウンロード、コピー、再アップロード、送信しないでください/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: /NCMEC CyberTipline/ })).toBeVisible();
  },
};

export const Japanese: Story = {
  args: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /著作権/ }));
    await expect(canvas.getByRole('heading', { name: '著作権侵害の通知' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '報告を送信' })).toBeVisible();
  },
};

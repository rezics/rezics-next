import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CaseView } from './case-view.tsx';
import type { CaseStatus } from './report.ts';

const caseId = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const credential = 'B'.repeat(43);
const status = (overrides: Partial<CaseStatus> = {}): CaseStatus => ({ profile: 'public-report-v1', reportId: 'r', caseId,
  receivedAt: '2026-10-01T09:00:00.000Z', state: 'open', generation: '1', category: 'harassment',
  contentLanguage: 'en', process: 'platform_rules', outcome: null, reasons: null, statementOfReasons: null, operation: null, nextCursor: null,
  steps: [{ id: 's1', kind: 'intake', occurredAt: '2026-10-01T09:00:00.000Z', dueAt: null, statement: null,
    contentLanguage: null }], ...overrides });

let sent: Array<{ url: string; credential: string | null; key: string | null; body: Record<string, unknown> }> = [];
const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  sent.push({ url: String(input), credential: headers.get('x-rezics-case-credential'), key: headers.get('idempotency-key'),
    body: init?.body ? JSON.parse(String(init.body)) : {} });
  if (String(input).includes('/correspondence')) return Response.json({ profile: 'public-report-v1', stepId: 's2', replayed: false });
  return Response.json(status());
}) as typeof fetch;

const meta = {
  title: 'Safety/Case status',
  component: CaseView,
  parameters: { route: { pathname: `/en/report/${caseId}` } },
  args: { locale: 'en', caseId, credential, send, initial: { kind: 'loaded', status: status() } },
  beforeEach() { sent = []; },
  render: args => <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6"><CaseView {...args} /></div>,
} satisfies Meta<typeof CaseView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An open report: its status, no outcome yet, and a way to write to us, with no appeal before a decision. */
export const Open: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Harassment or bullying')).toBeVisible();
    await expect(canvas.getByText(/There is no decision yet/)).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Appeal this decision' })).toBeNull();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Your message' }), 'Here is the link again.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(canvas.getByText(/Sent\. It appears in the history/)).toBeVisible());
    const write = sent.find(call => call.url.endsWith('/correspondence'))!;
    await expect(write.url).toBe(`/en/report/relay/v1/public-reports/${caseId}/correspondence`);
    await expect(write.credential).toBe(credential);
    await expect(write.url).not.toContain(credential);
    await expect(write.body).toMatchObject({ kind: 'message', statement: 'Here is the link again.', contentLanguage: 'und' });
  },
};

/** A decision shows its outcome and reasons, and the person it affects can appeal. */
export const DecisionWithAppeal: Story = {
  args: { initial: { kind: 'loaded', status: status({ state: 'closed', outcome: 'restrict',
    reasons: 'The post breaks the harassment rule.' }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Restricted')).toBeVisible();
    await expect(canvas.getByText('The post breaks the harassment rule.')).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Why should it change?' }), 'It was a joke between friends.');
    await userEvent.click(canvas.getByRole('button', { name: 'Send appeal' }));
    await waitFor(() => expect(sent.some(call => call.body.kind === 'appeal')).toBe(true));
  },
};

/** The NCII removal deadline is on the page: the 48-hour notice and the time it is due. */
export const NciiDeadline: Story = {
  args: { initial: { kind: 'loaded', status: status({ category: 'ncii', process: 'ncii', steps: [
    { id: 's1', kind: 'intake', occurredAt: '2026-10-01T09:00:00.000Z', dueAt: null, statement: null, contentLanguage: null },
    { id: 's2', kind: 'removal_deadline', occurredAt: '2026-10-01T09:00:00.000Z', dueAt: '2026-10-03T09:00:00.000Z',
      statement: null, contentLanguage: null }] }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/no later than 48 hours after we receive it/)).toBeVisible();
    await expect(canvas.getByText('Removal deadline')).toBeVisible();
    await expect(canvas.getByText(/Due by/)).toBeVisible();
  },
};

/** A copyright decision opens the counter-notice, which warns that the sender's details are disclosed. */
export const CounterNotice: Story = {
  args: { initial: { kind: 'loaded', status: status({ category: 'copyright', process: 'dmca_512', state: 'closed',
    outcome: 'restrict' }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Send a counter-notice' })).toBeVisible();
    await expect(canvas.getByText(/given to the person who sent the original notice/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Send counter-notice' }));
    // Each missing field and statement says so itself, and focus goes to the first.
    await expect(await canvas.findAllByText('Fill this in.')).toHaveLength(7);
    await expect(canvas.getAllByText('Tick this statement to continue.')).toHaveLength(3);
    await expect(canvas.getByRole('textbox', { name: 'What was removed by mistake, and why?' })).toHaveFocus();
    await expect(sent.some(call => call.body.kind === 'counter_notice')).toBe(false);
    await userEvent.type(canvas.getByRole('textbox', { name: 'What was removed by mistake, and why?' }), 'It is my own work.');
    for (const [name, value] of [['Where the material was before it was removed', '/w/0001'], ['Your full name', 'Bo Li'],
      ['Postal address', '2 Rain St'], ['Phone number', '+1 555 0100'], ['Court district for your address', 'N.D. Cal.'],
      ['Signature (type your full name)', 'Bo Li']] as const) {
      await userEvent.type(canvas.getByRole('textbox', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }), value);
    }
    await userEvent.click(canvas.getByRole('checkbox', { name: /mistake or misidentification/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /consent to the jurisdiction/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /accept service of process/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Send counter-notice' }));
    await waitFor(() => expect(sent.some(call => call.body.kind === 'counter_notice')).toBe(true));
    const counter = sent.find(call => call.body.kind === 'counter_notice')!;
    await expect(counter.body.counterNotice).toMatchObject({ name: 'Bo Li', goodFaithMistakeUnderPerjury: true,
      consentToJurisdiction: true, acceptService: true });
  },
};

/** A follow-up with nothing written says so on the field and focuses it. */
export const EmptyMessage: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Send message' }));
    await expect(await canvas.findByText('Write a message.')).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Your message' })).toHaveFocus();
  },
};

/** A link Main does not know says so; it is not told it lacks the right to send a counter-notice. */
export const ExpiredLink: Story = {
  args: { send: (async (input: URL | RequestInfo) => String(input).includes('/correspondence')
    ? new Response(null, { status: 404 }) : Response.json(status())) as typeof fetch },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Your message' }), 'Hello?');
    await userEvent.click(canvas.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('The link may be wrong or incomplete.'));
    await expect(canvas.queryByText(/Only the person whose material was removed/)).toBeNull();
  },
};

/** Anyone with a decision on their case can disagree with it, the reporter included. */
export const AppealWording: Story = {
  args: { initial: { kind: 'loaded', status: status({ state: 'closed', outcome: 'dismiss' }) } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/If you disagree with this decision, say why/)).toBeVisible();
  },
};

/** Correspondence keeps its own language. */
export const CorrespondenceLanguage: Story = {
  args: { initial: { kind: 'loaded', status: status({ steps: [
    { id: 's1', kind: 'intake', occurredAt: '2026-10-01T09:00:00.000Z', dueAt: null, statement: null, contentLanguage: null },
    { id: 's2', kind: 'message', occurredAt: '2026-10-01T10:00:00.000Z', dueAt: null, statement: 'もう一度確認してください。',
      contentLanguage: 'ja' }] }) } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('もう一度確認してください。')).toHaveAttribute('lang', 'ja');
  },
};

/** An address without its private key says so and offers nothing else. */
export const MissingKey: Story = {
  args: { initial: { kind: 'no-key' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('This address is missing its private key')).toBeVisible();
  },
};

/** A wrong or unknown link: the same answer, revealing nothing. */
export const Unavailable: Story = {
  args: { initial: { kind: 'unavailable' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('This report is unavailable')).toBeVisible();
  },
};

export const TraditionalChinese: Story = {
  args: { locale: 'zh-Hant', initial: { kind: 'loaded', status: status({ category: 'ncii', process: 'ncii' }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/最遲在收到後 48 小時內完成/)).toBeVisible();
  },
};

export const Japanese: Story = {
  args: { locale: 'ja', initial: { kind: 'loaded', status: status({ state: 'closed', outcome: 'dismiss' }) } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('措置なし')).toBeVisible();
  },
};

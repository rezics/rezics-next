import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromMarkdown } from '@rezics/document';
import { direction } from '@rezics/main/language';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { contentLanguageText } from '../content-language/messages.ts';
import { storyQuietThread, storyRealm, storyThread } from '../feed/thread-fixtures.ts';
import type { ThreadRead } from '../feed/thread.ts';
import { AboutDiscussion } from './about-discussion.tsx';
import type { AboutDiscussionApi, AboutDiscussionRead, AboutPostIntent, AboutPostOutcome } from './about-discussion-api.ts';
import { aboutDiscussionMessages } from './about-discussion-messages.ts';
import { spaceHref } from '../address/path.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const basis = { realm: storyThread.realm, about: storyThread.work.id, targetRevision: storyThread.rootRevision,
  zone: id(801), path: '/works/pride-and-prejudice', routeRevision: id(802) };
const ready: Extract<AboutDiscussionRead, { kind: 'ready' }> = {
  kind: 'ready', basis, thread: null, mode: 'open', actingSubject: id(803),
  realmName: { value: storyRealm.name, language: 'en', direction: direction('en', storyRealm.name) },
};
const posted: AboutPostOutcome = { kind: 'posted', reply: id(804) };
type MemoryApi = { post: ReturnType<typeof fn<AboutDiscussionApi['post']>> };

/** Each story owns its mock. Call counts also make replaying a story restart its outcome sequence. */
function memoryApi(...outcomes: AboutPostOutcome[]): MemoryApi {
  const post: MemoryApi['post'] = fn<AboutDiscussionApi['post']>(async () =>
    outcomes[Math.min(post.mock.calls.length - 1, outcomes.length - 1)]!);
  return { post };
}

const meta = {
  title: 'Zones/About discussion',
  component: AboutDiscussion,
  args: { read: ready, locale: 'en', href: spaceHref('reading', 'site', ['works', 'pride-and-prejudice']),
    retain: false, api: memoryApi(posted) },
  parameters: { route: { pathname: `/en${spaceHref('reading', 'site', ['works', 'pride-and-prejudice'])}` } },
  render: args => <div className="mx-auto w-full max-w-[640px] px-5 py-6"><AboutDiscussion {...args} /></div>,
  beforeEach: ({ args }) => { (args.api as MemoryApi).post.mockClear(); },
} satisfies Meta<typeof AboutDiscussion>;
export default meta;
type Story = StoryObj<typeof meta>;
type Canvas = ReturnType<typeof within>;
const t = aboutDiscussionMessages.en;
const message = 'Which translation would you recommend for a first reading?';

async function write(canvas: Canvas, text = message) {
  await userEvent.click(canvas.getByRole('button', { name: t.start }));
  const body = canvas.getByRole('textbox', { name: t.body });
  await userEvent.type(body, text);
  return body;
}

async function assertLocked(canvas: Canvas, text = message) {
  const body = canvas.getByRole('textbox', { name: t.body });
  await expect(body).toBeDisabled();
  await expect(body).toHaveValue(text);
  await expect(canvas.getByRole('button', { name: /^Message language:/ })).toBeDisabled();
  await expect(canvas.getByRole('checkbox', { name: t.spoiler })).toBeDisabled();
}

async function assertEditable(canvas: Canvas, text = message) {
  await expect(canvas.getByRole('textbox', { name: t.body })).toBeEnabled();
  await expect(canvas.getByRole('textbox', { name: t.body })).toHaveValue(text);
  await expect(canvas.getByRole('button', { name: /^Message language:/ })).toBeEnabled();
  await expect(canvas.getByRole('checkbox', { name: t.spoiler })).toBeEnabled();
  await expect(canvas.getByRole('button', { name: t.send })).toBeEnabled();
  await expect(canvas.queryByRole('button', { name: t.retry })).toBeNull();
}

export const NoAttachedRealm: Story = {
  args: { read: { kind: 'none' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('heading', { name: t.title })).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const StartDiscussion: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: t.title })).toBeVisible();
    await expect(canvas.getByText(t.empty)).toBeVisible();
    await expect(canvas.getByRole('button', { name: t.start })).toBeVisible();
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const OpenComposer: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: t.start }));
    await expect(canvas.getByRole('textbox', { name: t.body })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: t.send })).toBeDisabled();
    await userEvent.type(canvas.getByRole('textbox', { name: t.body }), message);
    await expect(canvas.getByRole('button', { name: t.send })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: `${t.language}: ${contentLanguageText.notSpecified.en}` })).toBeVisible();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const VisibleThread: Story = {
  args: { read: { ...ready, thread: storyQuietThread } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(canvas.getByRole('heading', { name: 'Frankenstein for Halloween?' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: t.continueThread })).toBeVisible();
    await expect(canvas.queryByText(t.empty)).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: t.reply }));
    await expect(canvas.getByRole('textbox', { name: t.body })).toBeVisible();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const SignedOut: Story = {
  args: { read: { ...ready, mode: 'sign-in', actingSubject: null, thread: storyQuietThread } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: t.signIn })).toBeVisible();
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(canvas.queryByRole('button', { name: t.reply })).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const ChoosePersonalIdentity: Story = {
  args: { read: { ...ready, mode: 'identity', actingSubject: null } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: t.chooseIdentity })).toHaveAttribute('href', expect.stringContaining('/identity?next='));
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const JoinCommunity: Story = {
  args: { read: { ...ready, mode: 'join' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: t.join })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: t.start })).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const ReviewRequired: Story = {
  args: { read: { ...ready, mode: 'reviewed' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.reviewed);
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvas.queryByRole('button', { name: t.start })).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const ReadUnavailable: Story = {
  args: { read: { kind: 'unavailable' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.unavailable);
    await expect(canvas.getByRole('button', { name: t.retry })).toBeVisible();
    await expect(canvas.queryByText(t.empty)).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const PostingAuthorityUnavailable: Story = {
  args: { read: { ...ready, mode: 'unavailable', thread: storyQuietThread } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.postingUnavailable);
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(canvas.queryByRole('button', { name: t.reply })).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const ClosedOperation: Story = {
  args: { read: { ...ready, mode: 'closed', thread: storyQuietThread } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: t.title })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent(t.postingUnavailable);
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: t.continueThread })).toBeVisible();
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvas.queryByRole('button', { name: t.reply })).toBeNull();
    await expect(canvas.queryByText(t.unavailable)).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

const richDocumentThread: ThreadRead = { ...storyQuietThread, items: [{ ...storyQuietThread.items[0]!,
  title: 'A passage worth discussing', body: 'Obsolete plain-text fallback',
  document: fromMarkdown('**The choice matters.**\n\n> A sentence from the authoritative document.\n\n- Compare the translations.\n- Name your edition.'),
}] };
export const RichDocumentThread: Story = {
  args: { read: { ...ready, thread: richDocumentThread } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('The choice matters.')).toBeVisible();
    await expect(canvas.getByText('The choice matters.').closest('strong')).not.toBeNull();
    await expect(canvas.getByText('A sentence from the authoritative document.')).toBeVisible();
    await expect(canvas.getByText('A sentence from the authoritative document.').closest('blockquote')).not.toBeNull();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.queryByText('Obsolete plain-text fallback')).toBeNull();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const PostingInFlight: Story = {
  args: { api: { post: fn<AboutDiscussionApi['post']>(() => new Promise<AboutPostOutcome>(() => {})) } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await write(canvas);
    await userEvent.dblClick(canvas.getByRole('button', { name: t.send }), { pointerEventsCheck: 0 });
    await waitFor(() => expect(args.api!.post).toHaveBeenCalledTimes(1));
    await expect(canvas.getByRole('button', { name: t.sending })).toBeDisabled();
    await assertLocked(canvas);
  },
};

export const Pending202: Story = {
  args: { api: memoryApi({ kind: 'pending' }) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as MemoryApi;
    await write(canvas);
    await userEvent.click(canvas.getByRole('checkbox', { name: t.spoiler }));
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.pending);
    await expect(api.post).toHaveBeenCalledTimes(1);
    await assertLocked(canvas);
    const first = api.post.mock.calls[0]![0];
    const frozen = structuredClone(first);
    await expect(first).toMatchObject({ basis, actingSubject: ready.actingSubject,
      body: message, language: 'und', spoiler: true });
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await expect(api.post.mock.calls[1]![0]).toBe(first);
    await expect(api.post.mock.calls[1]![0]).toEqual(frozen);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.pending);
    await assertLocked(canvas);
  },
};

export const RefusedKeepsText: Story = {
  args: { api: memoryApi({ kind: 'refused' }) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await write(canvas);
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t.refused);
    await expect(canvas.getByRole('textbox', { name: t.body })).toHaveValue(message);
    await assertEditable(canvas);
    await expect(args.api!.post).toHaveBeenCalledTimes(1);
  },
};

export const LostResponseRecovery: Story = {
  args: { api: { post: fn<AboutDiscussionApi['post']>(async () => { throw new Error('Response lost'); }) } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as MemoryApi;
    await write(canvas);
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await expect(api.post).toHaveBeenCalledTimes(1);
    await assertLocked(canvas);
    const first = api.post.mock.calls[0]![0];
    const frozen = structuredClone(first);
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await expect(api.post.mock.calls[1]![0]).toBe(first);
    await expect(api.post.mock.calls[1]![0]).toEqual(frozen);
    await expect(first.key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.recovery);
    await assertLocked(canvas);
  },
};

export const Stale409: Story = {
  args: { api: memoryApi({ kind: 'stale' }) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await write(canvas);
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t.reload);
    await expect(canvas.getByRole('button', { name: t.refresh })).toBeVisible();
    await assertEditable(canvas);
    await expect(args.api!.post).toHaveBeenCalledTimes(1);
  },
};

export const SuccessfulPost: Story = {
  args: { api: memoryApi(posted) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await write(canvas);
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.posted);
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvas.getByRole('button', { name: t.start })).toBeVisible();
    await expect(args.api!.post).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: t.start }));
    await expect(canvas.getByRole('textbox', { name: t.body })).toHaveValue('');
    await expect(canvas.getByRole('checkbox', { name: t.spoiler })).not.toBeChecked();
  },
};

export const RecoveryFindsReceipt: Story = {
  args: { api: memoryApi({ kind: 'recovery' }, posted) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as MemoryApi;
    await write(canvas);
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    const first = structuredClone(api.post.mock.calls[0]![0]);
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await expect(await canvas.findByText(t.posted)).toBeVisible();
    await expect(api.post).toHaveBeenCalledTimes(2);
    await expect(api.post.mock.calls[1]![0]).toEqual(first);
    await expect(canvas.queryByRole('textbox')).toBeNull();
  },
};

export const TerminalRefusalStartsFreshIntent: Story = {
  args: { api: memoryApi({ kind: 'refused' }, posted) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as MemoryApi;
    await write(canvas);
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t.refused);
    await assertEditable(canvas);
    const first = structuredClone(api.post.mock.calls[0]![0]);
    const corrected = `${message} I can now take part.`;
    await userEvent.type(canvas.getByRole('textbox', { name: t.body }), ' I can now take part.');
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByText(t.posted)).toBeVisible();
    await expect(api.post).toHaveBeenCalledTimes(2);
    await expect(api.post.mock.calls[1]![0].key).not.toBe(first.key);
    await expect(api.post.mock.calls[1]![0]).toMatchObject({ basis, body: corrected,
      actingSubject: first.actingSubject, language: first.language, spoiler: first.spoiler });
    await expect(canvas.queryByRole('textbox')).toBeNull();
  },
};

const correctedBasis = { ...basis, targetRevision: id(901), routeRevision: id(902) };
/** A refreshed read changes the basis without discarding the editable words. */
function CorrectedBasisComposer(args: React.ComponentProps<typeof AboutDiscussion>) {
  const [read, setRead] = useState<AboutDiscussionRead>(ready);
  const api: AboutDiscussionApi = { async post(intent) {
    const result = await args.api!.post(intent);
    if (result.kind === 'stale') setRead({ ...ready, basis: correctedBasis });
    return result;
  } };
  return <div className="mx-auto w-full max-w-[640px] px-5 py-6"><AboutDiscussion {...args} read={read} api={api} /></div>;
}

export const StaleBasisCorrectedPost: Story = {
  args: { api: memoryApi({ kind: 'stale' }, posted) },
  render: args => <CorrectedBasisComposer {...args} />,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as MemoryApi;
    await write(canvas);
    await userEvent.click(canvas.getByRole('checkbox', { name: t.spoiler }));
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t.reload);
    await assertEditable(canvas);
    await expect(canvas.getByRole('checkbox', { name: t.spoiler })).toBeChecked();
    const first = structuredClone(api.post.mock.calls[0]![0]);
    await expect(first.basis).toEqual(basis);
    await userEvent.type(canvas.getByRole('textbox', { name: t.body }), ' The revised edition too.');
    await userEvent.click(canvas.getByRole('button', { name: t.send }));
    await expect(await canvas.findByText(t.posted)).toBeVisible();
    await expect(api.post).toHaveBeenCalledTimes(2);
    await expect(api.post.mock.calls[1]![0].key).not.toBe(first.key);
    await expect(api.post.mock.calls[1]![0]).toMatchObject({ basis: correctedBasis,
      body: `${message} The revised edition too.`, actingSubject: first.actingSubject,
      language: first.language, spoiler: true });
  },
};

function retainedFixture(path: string) {
  const saved: AboutPostIntent = { key: 'storybook-retained-intent', basis: { ...basis, path },
    actingSubject: ready.actingSubject!, body: 'هذه رسالة تنتظر تأكيد النشر.', language: 'ar', spoiler: true };
  const key = `rezics:about-post:${saved.actingSubject}:${basis.zone}:${path}`;
  return { saved, key, prepare(api: MemoryApi) {
    api.post.mockClear();
    const previous = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify(saved));
    // Restore only this story's own key; never clear the browser's storage.
    return () => { if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous); };
  } };
}

const reload = retainedFixture('/__storybook__/about-discussion/reload');
const reloadApi = memoryApi(posted);
export const ReloadRecoveryKeepsOriginalBasis: Story = {
  args: { retain: true, api: reloadApi,
    read: { ...ready, basis: { ...reload.saved.basis, targetRevision: id(901), routeRevision: id(902) } } },
  beforeEach: () => reload.prepare(reloadApi),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await assertLocked(canvas, reload.saved.body);
    await expect(canvas.getByRole('textbox', { name: t.body })).toHaveAttribute('lang', 'ar');
    await expect(canvas.getByRole('checkbox', { name: t.spoiler })).toBeChecked();
    await expect(reloadApi.post).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await expect(await canvas.findByText(t.posted)).toBeVisible();
    await expect(reloadApi.post).toHaveBeenCalledTimes(1);
    await expect(reloadApi.post.mock.calls[0]![0]).toEqual(reload.saved);
    await expect(localStorage.getItem(reload.key)).toBeNull();
  },
};

const closed = retainedFixture('/__storybook__/about-discussion/closed');
const closedApi = memoryApi({ kind: 'closed' }, posted);
export const ClosedGrantKeepsRetainedIntent: Story = {
  args: { retain: true, api: closedApi, read: { ...ready, basis: closed.saved.basis, thread: storyQuietThread } },
  beforeEach: () => closed.prepare(closedApi),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await assertLocked(canvas, closed.saved.body);
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.postingUnavailable);
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvas.queryByRole('button', { name: t.retry })).toBeNull();
    await expect(canvas.queryByRole('button', { name: t.reply })).toBeNull();
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: t.continueThread })).toBeVisible();
    await expect(closedApi.post).toHaveBeenCalledTimes(1);
    await expect(JSON.parse(localStorage.getItem(closed.key)!)).toEqual(closed.saved);
  },
};

function RefreshedGrantComposer(args: React.ComponentProps<typeof AboutDiscussion>) {
  const [read, setRead] = useState(args.read);
  const [refreshed, setRefreshed] = useState(false);
  return <div className="mx-auto w-full max-w-[640px] px-5 py-6">
    <AboutDiscussion {...args} read={read} />
    {!refreshed ? <button type="button" onClick={() => {
      setRead({ ...ready, basis: reopened.saved.basis });
      setRefreshed(true);
    }}>Refresh platform access</button> : null}
  </div>;
}

const reopened = retainedFixture('/__storybook__/about-discussion/reopened');
const reopenedApi = memoryApi({ kind: 'closed' }, posted);
export const ReopenedGrantRecoversRetainedIntent: Story = {
  args: { retain: true, api: reopenedApi, read: { ...ready, basis: reopened.saved.basis } },
  beforeEach: () => reopened.prepare(reopenedApi),
  render: args => <RefreshedGrantComposer {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.postingUnavailable);
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh platform access' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await assertLocked(canvas, reopened.saved.body);
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await expect(await canvas.findByText(t.posted)).toBeVisible();
    await expect(reopenedApi.post.mock.calls.map(([intent]) => intent)).toEqual([reopened.saved, reopened.saved]);
    await expect(localStorage.getItem(reopened.key)).toBeNull();
  },
};

const closedRead = retainedFixture('/__storybook__/about-discussion/closed-read');
const closedReadApi = memoryApi(posted);
export const ClosedPostingWithRetainedIntent: Story = {
  args: { retain: true, api: closedReadApi,
    read: { ...ready, basis: closedRead.saved.basis, thread: storyQuietThread, mode: 'closed' } },
  beforeEach: () => closedRead.prepare(closedReadApi),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(t.postingUnavailable);
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.getAllByRole('article')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: t.continueThread })).toBeVisible();
    await expect(closedReadApi.post).not.toHaveBeenCalled();
    await expect(JSON.parse(localStorage.getItem(closedRead.key)!)).toEqual(closedRead.saved);
  },
};

const closedLookup = retainedFixture('/__storybook__/about-discussion/closed-lookup');
const closedLookupApi = memoryApi(posted);
export const ClosedLookupRecoveryKeepsRetainedIntent: Story = {
  args: { read: { kind: 'unavailable' }, retain: true, api: closedLookupApi,
    recoveryScope: { zone: basis.zone, path: closedLookup.saved.basis.path,
      actingSubject: closedLookup.saved.actingSubject, signedIn: true, personal: true, postingOpen: false } },
  beforeEach: () => closedLookup.prepare(closedLookupApi),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent(t.postingUnavailable));
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(closedLookupApi.post).not.toHaveBeenCalled();
    await expect(JSON.parse(localStorage.getItem(closedLookup.key)!)).toEqual(closedLookup.saved);
  },
};

const refused = retainedFixture('/__storybook__/about-discussion/refused');
const refusedApi = memoryApi({ kind: 'refused' });
export const TerminalRefusalClearsDeviceIntent: Story = {
  args: { retain: true, api: refusedApi, read: { ...ready, basis: refused.saved.basis } },
  beforeEach: () => refused.prepare(refusedApi),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await assertLocked(canvas, refused.saved.body);
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t.refused);
    await assertEditable(canvas, refused.saved.body);
    await expect(canvas.getByRole('textbox', { name: t.body })).toHaveAttribute('lang', 'ar');
    await expect(canvas.getByRole('checkbox', { name: t.spoiler })).toBeChecked();
    await expect(localStorage.getItem(refused.key)).toBeNull();
    await expect(refusedApi.post.mock.calls[0]![0]).toEqual(refused.saved);
  },
};

const detached = retainedFixture('/__storybook__/about-discussion/detached-recovery');
const detachedApi = memoryApi(posted);
export const WithdrawnAttachmentRecovery: Story = {
  args: { read: { kind: 'none' }, retain: true, api: detachedApi,
    recoveryScope: { zone: basis.zone, path: detached.saved.basis.path,
      actingSubject: detached.saved.actingSubject, signedIn: true, personal: true, postingOpen: true } },
  beforeEach: () => detached.prepare(detachedApi),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.recovery);
    await assertLocked(canvas, detached.saved.body);
    await expect(canvas.queryByRole('link', { name: t.continueThread })).toBeNull();
    await expect(detachedApi.post).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await waitFor(() => expect(detachedApi.post).toHaveBeenCalledTimes(1));
    await expect(detachedApi.post.mock.calls[0]![0]).toEqual(detached.saved);
    await waitFor(() => expect(localStorage.getItem(detached.key)).toBeNull());
  },
};

export const KoreanContentJapaneseInterface: Story = {
  args: { locale: 'ja', api: memoryApi({ kind: 'pending' }) },
  globals: { locale: 'ja' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const ja = aboutDiscussionMessages.ja;
    await userEvent.click(canvas.getByRole('button', { name: ja.start }));
    await expect(canvas.getByRole('button', { name: `${ja.language}: ${contentLanguageText.notSpecified.ja}` })).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: ja.body }), '어떤 번역을 추천하시나요?');
    await userEvent.click(canvas.getByRole('button', { name: new RegExp(`^${ja.language}:`) }));
    const overlay = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: ja.language });
    await userEvent.type(within(overlay).getByRole('searchbox'), 'ko');
    const korean = await within(overlay).findByRole('button', { name: /한국어/ });
    await waitFor(() => expect(korean).toBeVisible());
    await userEvent.click(korean);
    await expect(canvas.getByRole('textbox', { name: ja.body })).toHaveAttribute('lang', 'ko');
    await userEvent.click(canvas.getByRole('button', { name: ja.send }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(ja.pending);
    await expect(args.api!.post).toHaveBeenCalledTimes(1);
    await expect((args.api as MemoryApi).post.mock.calls[0]![0].language).toBe('ko');
  },
};

export const NonLatinByteLimit: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: t.start }));
    const body = canvas.getByRole('textbox', { name: t.body });
    await userEvent.click(body);
    // 2,731 three-byte characters exceed 8 KiB despite a much smaller character count.
    await userEvent.paste('界'.repeat(2731));
    await expect(body).toHaveValue('界'.repeat(2731));
    await expect(canvas.getByRole('alert')).toHaveTextContent(t.tooLong);
    await expect(canvas.getByRole('button', { name: t.send })).toBeDisabled();
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

export const MixedScriptsPhone: Story = {
  args: { locale: 'zh-Hant', read: { ...ready, thread: { ...storyThread, items: [
    { ...storyThread.items[0]!, title: '一起讀這段文字 — Reading together — 함께 읽기', language: 'zh-Hant',
      body: '這段文字讓我想到不同譯本的語氣。日本語でも読み比べてみたいです。 What changes between translations? '
        + 'https://example.invalid/' + 'a-long-unbroken-address'.repeat(8) },
    { ...storyThread.items[1]!, title: null, language: 'ar', body: 'أحب مقارنة الترجمات. 你最喜歡哪一版？ 어떤 번역을 좋아하세요?' },
  ] } } },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const zh = aboutDiscussionMessages['zh-Hant'];
    await expect(canvas.getAllByRole('article')).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: zh.continueThread })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: zh.reply }));
    await userEvent.type(canvas.getByRole('textbox', { name: zh.body }), '讀到這裡，我想知道 다른 번역에서는 어떻게 표현했나요?');
    await expect(canvas.getByRole('textbox', { name: zh.body })).not.toHaveAttribute('lang');
    await waitFor(() => expect(canvasElement.ownerDocument.documentElement.scrollWidth)
      .toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth + 1));
    await expect(args.api!.post).not.toHaveBeenCalled();
  },
};

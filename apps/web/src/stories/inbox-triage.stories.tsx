import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { inboxTriageStory, resetInboxTriageStory } from '../kernel/fake/notifications';
import { PageStory } from './page';

const meta = { title: 'Pages/Account/Inbox', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const newestId = '01a17a3b-0884-721b-91ef-d7ffd7bb5801';
const unreadId = '01a17a3b-0884-721b-91ef-d7ffd7bb5802';
const oldestId = '01a17a3b-0884-721b-91ef-d7ffd7bb5803';

function rowIds(list: HTMLElement) {
  return [...list.querySelectorAll<HTMLElement>('[data-notice-id]')].map((row) => row.dataset.noticeId);
}

function expectPhoneControl(control: HTMLElement, canvasElement: HTMLElement) {
  const bounds = control.getBoundingClientRect();
  const viewportWidth = canvasElement.ownerDocument.documentElement.clientWidth;
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(viewportWidth);
}

export const TriageJourney: Story = {
  name: 'Unread triage and deliberate acknowledgement',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  beforeEach: () => resetInboxTriageStory(),
  render: () => <PageStory visitor="Signed In" path="/inbox?fixture=triage-journey" />,
  play: async ({ canvasElement }) => {
    const main = within(await within(canvasElement).findByRole('main'));
    const firstRows = await main.findByRole('list', { name: m.inbox_heading() });
    await expect(rowIds(firstRows)).toEqual([newestId]);
    await expect(inboxTriageStory.pageReads).toBe(1);
    await expect(inboxTriageStory.writes).toHaveLength(0);

    const all = main.getByRole('button', { name: m.inbox_triage_filter_all() });
    const unread = main.getByRole('button', { name: m.inbox_triage_filter_unread() });
    expectPhoneControl(all, canvasElement);
    expectPhoneControl(unread, canvasElement);
    await userEvent.click(unread);
    await main.findByText(m.inbox_triage_no_unread_loaded());
    await main.findByText(m.inbox_triage_older_pages());
    const loadMore = main.getByRole('button', { name: m.inbox_load_more() });
    expectPhoneControl(loadMore, canvasElement);
    await expect(inboxTriageStory.pageReads).toBe(1);
    await expect(inboxTriageStory.writes).toHaveLength(0);

    await userEvent.click(loadMore);
    const filteredRows = await main.findByRole('list', { name: m.inbox_heading() });
    await expect(rowIds(filteredRows)).toEqual([unreadId]);
    await userEvent.click(all);
    const allLoadedRows = await main.findByRole('list', { name: m.inbox_heading() });
    await expect(rowIds(allLoadedRows)).toEqual([newestId, unreadId, oldestId]);
    await userEvent.click(unread);
    await expect(rowIds(await main.findByRole('list', { name: m.inbox_heading() }))).toEqual([unreadId]);
    await expect(inboxTriageStory.pageReads).toBe(2);
    await expect(inboxTriageStory.writes).toHaveLength(0);

    const mark = main.getByRole('button', { name: m.inbox_triage_mark() });
    expectPhoneControl(mark, canvasElement);
    // Two same-turn activations must still dispatch only one marker command.
    mark.click();
    mark.click();
    const status = (await main.findByText(m.inbox_seen_unavailable())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-status', '503');
    await expect(inboxTriageStory.writes).toHaveLength(1);
    const original = inboxTriageStory.writes[0]!;
    await expect(original.body).toEqual({ through: newestId });
    await expect(original.through).toBe(newestId);
    await expect(JSON.parse(original.key!)).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(main.queryByRole('button', { name: m.inbox_triage_mark() })).toBeNull();

    const access = within(status).getByRole('button', { name: m.inbox_check_access() });
    expectPhoneControl(access, canvasElement);
    inboxTriageStory.denyNextRead = true;
    const readsBeforeAccess = inboxTriageStory.pageReads;
    await userEvent.click(access);
    await main.findByText(m.inbox_read_denied());
    await expect(inboxTriageStory.pageReads).toBe(readsBeforeAccess + 1);
    await expect(inboxTriageStory.writes).toEqual([original]);
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_triage_filter_all() })).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_triage_mark() })).toBeNull();

    const restart = main.getByRole('button', { name: m.inbox_start_first_page() });
    expectPhoneControl(restart, canvasElement);
    await userEvent.click(restart);
    await userEvent.click(await main.findByRole('button', { name: m.inbox_triage_filter_all() }));
    await main.findByRole('list', { name: m.inbox_heading() });
    await expect(inboxTriageStory.writes).toEqual([original]);
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    expectPhoneControl(retry, canvasElement);
    await userEvent.click(retry);
    await main.findByText(m.inbox_triage_marked());
    await expect(inboxTriageStory.writes).toEqual([original, original]);
    await waitFor(() => expect(inboxTriageStory.pageReads).toBeGreaterThan(readsBeforeAccess + 1));
  },
};

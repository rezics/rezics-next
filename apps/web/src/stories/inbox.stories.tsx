import type { Meta, StoryObj } from '@storybook/react-vite';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Inbox', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Preview({ state }: { state: 'empty' | 'mixed' | 'unavailable' | 'many' | 'row-overlay' }) {
  const rows = {
    empty: [],
    mixed: [
      { text: 'A reply from Momo: “The last train leaves at midnight.”', href: '/en/threads/thread-1#post-1' },
      { text: 'Your report was actioned.', href: '/en/moderation/reports/report-1' },
      { text: 'A moderation decision is ready to read.', href: '/en/moderation/decisions/decision-1' },
    ],
    unavailable: [{ text: m.inbox_unavailable_item(), href: undefined }],
    many: [{ text: 'A new reply in your thread.', href: '/en/threads/thread-1#post-1' }],
    'row-overlay': [
      { text: 'A reply from Momo: “The last train leaves at midnight.”', href: '/en/threads/thread-1#post-1' },
      { text: 'Your report was actioned.', href: '/en/moderation/reports/report-1' },
    ],
  }[state];
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{m.inbox_heading()}</h1>
        {state === 'many' ? (
          <span className="rounded-full bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground">99+</span>
        ) : null}
      </div>
      {rows.length ? (
        <ol className="mt-6 space-y-1">
          {rows.map((row, index) => (
            <ListRow
              key={row.text}
              forceOverlay={state === 'row-overlay' && index === 0}
              className="flex flex-col items-start gap-1 py-4 sm:flex-row sm:items-baseline"
            >
              {row.href ? (
                <>
                  <ListRowLink href={row.href}>{row.text}</ListRowLink>
                  <p aria-hidden="true" className="text-sm leading-6">
                    {row.text}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{row.text}</p>
              )}
              <time className="mt-1 block text-xs text-muted-foreground" dateTime="2026-10-29T10:00:00Z">
                Oct 29, 2026, 10:00 AM
              </time>
            </ListRow>
          ))}
        </ol>
      ) : (
        <p className="mt-6 text-muted-foreground">{m.inbox_empty()}</p>
      )}
    </main>
  );
}

export const Empty: Story = { name: 'Empty', render: () => <Preview state="empty" /> };
export const Mixed: Story = { name: 'Mixed replies and moderation', render: () => <Preview state="mixed" /> };
export const Unavailable: Story = { name: 'Unavailable item', render: () => <Preview state="unavailable" /> };
export const MoreThanNinetyNine: Story = { name: 'More than 99 unread', render: () => <Preview state="many" /> };
export const RowOverlay: Story = { name: 'Row overlay', render: () => <Preview state="row-overlay" /> };

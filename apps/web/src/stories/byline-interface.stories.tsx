import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { PageAuthor } from '../identity/read';
import subject from '../kernel/recorded/subject.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Byline, fullDateTime, timeText } from '../threads/byline';

const createdAt = '2026-11-02T11:00:00.000Z';
const revisedAt = '2026-11-02T11:30:00.000Z';
const now = '2026-11-02T12:00:00.000Z';
const displayName = `Readers across languages 共讀 العربية ${'UnbrokenSuppliedName'.repeat(6)}`;
const handle = `carol/+雪_${'unbroken_supplied_handle_'.repeat(6)}`;
const carol = {
  id: '01a17a3a-20f5-72aa-9f14-f4cc56678188',
  state: 'active',
  kind: 'actor',
  displayName: 'Carol',
  handle: 'carol',
  automated: false,
  operatorId: null,
} satisfies PageAuthor;
const avatar = {
  ...subject.summary.cover,
  variants: [{ format: 'webp' as const, width: 320 }],
  credit: null,
};
const poison = {
  displayName: 'POISONED PRIVATE NAME',
  handle: 'poisoned-private-handle',
  avatar: { ...avatar, media: 'poisoned-private-image' },
  avatarUrl: 'https://poisoned-private-image.invalid/avatar',
  automated: true,
  operatorId: 'poisoned-private-operator',
};
const privacy = [
  { label: 'Missing identity', author: undefined, text: () => m.thread_author_unknown() },
  {
    label: 'Unknown automated identity',
    author: { ...carol, ...poison, displayName: null, handle: null },
    text: () => m.thread_author_unknown(),
  },
  ...(['actor', 'organization'] as const).map((kind) => ({
    label: `Deleted ${kind}`,
    author: { ...carol, ...poison, state: 'deleted', kind } as unknown as PageAuthor,
    text: () => (kind === 'organization' ? m.thread_author_deleted_organization() : m.thread_author_deleted()),
  })),
];

// Actual Byline with illustrative supplied DTOs. Observations are UNRUN under MINIMAL;
// no native identity, image transport, authorization or browser evidence is claimed.
const meta = {
  title: 'Community/Byline interface',
  id: 'patterns-community-byline-interface',
  component: Byline,
  parameters: { layout: 'fullscreen' },
  args: {
    author: { ...carol, displayName, handle },
    createdAt,
    now,
  },
  render: (args, { parameters }) => (
    <main id="thread" dir={parameters.direction ?? 'ltr'} className="mx-auto min-w-0 max-w-3xl space-y-4 p-4 sm:p-8">
      <button type="button" data-before-byline className="min-h-11 rounded-sm px-3">
        Before profile link
      </button>
      <Byline {...args}>
        <time dateTime={revisedAt} title={fullDateTime(revisedAt, getLocale())}>
          {m.thread_post_edited()}
        </time>
      </Byline>
      <button type="button" data-after-byline className="min-h-11 rounded-sm px-3">
        After profile link
      </button>
    </main>
  ),
} satisfies Meta<typeof Byline>;
export default meta;
type Story = StoryObj<typeof meta>;

const observe: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const row = canvasElement.querySelector('#thread p > span')!;
  const identity = row.firstElementChild!;
  const author = args.author;
  if (!author || author.state !== 'active') throw new Error('This observation requires an admitted active identity.');
  const canvas = within(row as HTMLElement);
  if (author.displayName) await expect(canvas.getByText(author.displayName, { exact: true })).toBeVisible();
  if (author.handle) await expect(canvas.getByText(`@${author.handle}`, { exact: true })).toBeVisible();
  const style = getComputedStyle(identity);
  await expect(style.whiteSpace).toBe('normal');
  await expect(style.overflow).toBe('visible');
  await expect(style.textOverflow).toBe('clip');
  await expect(style.overflowWrap).toBe('anywhere');
  await expect(identity).toHaveAttribute(
    'title',
    [author.displayName, author.handle ? `@${author.handle}` : null].filter(Boolean).join(' '),
  );
  if ((author.displayName?.length ?? 0) > 80 || (author.handle?.length ?? 0) > 80)
    await expect(identity.getBoundingClientRect().height).toBeGreaterThan(Number.parseFloat(style.lineHeight));
  await expect(identity.scrollWidth).toBeLessThanOrEqual(identity.clientWidth + 1);
  await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  await expect(row.querySelector('[data-slot="content-item-frame"]')).toBeNull();

  const times = [...row.querySelectorAll('time')];
  await expect(times.map((time) => time.dateTime)).toEqual([args.createdAt, revisedAt]);
  await expect(times[0]).toHaveTextContent(timeText(args.createdAt, args.now, getLocale()));
  await expect(times[0]).toHaveAttribute('title', fullDateTime(args.createdAt, getLocale()));
  await expect(times[1]).toHaveAttribute('title', fullDateTime(revisedAt, getLocale()));
  const metadata = row.lastElementChild!;
  await expect(metadata.tagName).toBe('SPAN');
  await expect(metadata.children).toHaveLength(2);
  const separator = metadata.querySelector('[aria-hidden="true"]')!;
  await expect(separator.textContent).toBe('\u00b7');
  await expect(separator.nextSibling?.textContent).toBe('\u00a0');
  await expect(separator.parentElement?.contains(times[1]!)).toBe(true);

  const links = [...row.querySelectorAll<HTMLAnchorElement>('a')];
  await expect(links).toHaveLength(author.handle ? 1 : 0);
  if (author.handle) {
    const link = links[0]!;
    await expect(link).toHaveAttribute('href', `/${getLocale()}/@${encodeURIComponent(author.handle)}`);
    const bounds = link.getBoundingClientRect();
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth + 1);
    (canvasElement.querySelector('[data-before-byline]') as HTMLButtonElement).focus();
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await expect(link.matches(':focus-visible')).toBe(true);
    const focus = getComputedStyle(link);
    await expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(2);
    await expect(focus.outlineStyle).toBe('solid');
    await expect(Number.parseFloat(focus.outlineOffset)).toBeGreaterThanOrEqual(2);
    await expect(focus.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
    const destinations: string[] = [];
    const follow = (event: MouseEvent) => {
      event.preventDefault();
      destinations.push(link.getAttribute('href')!);
    };
    link.addEventListener('click', follow);
    try {
      await userEvent.keyboard('{Enter}');
      await expect(destinations).toEqual([`/${getLocale()}/@${encodeURIComponent(author.handle)}`]);
    } finally {
      link.removeEventListener('click', follow);
    }
    await userEvent.tab();
    await expect(canvasElement.querySelector('[data-after-byline]')).toHaveFocus();
  }
  const portrait = canvasElement.querySelector('[data-slot="avatar"]')!;
  await expect(portrait).toHaveAttribute('aria-hidden', 'true');
  await expect(portrait).toHaveAttribute('data-size', args.size === 'sm' ? 'sm' : 'default');
};

export const LongNamePhone: Story = { name: 'Long Name', globals: {}, play: observe };
export const LongNameDesktop: Story = { tags: ['!dev'], globals: {}, play: observe };
export const LongNameRtl: Story = {
  globals: { locale: 'fr' },
  parameters: { direction: 'rtl' },
  args: { size: 'sm' },
  play: observe,
};
export const HandleOnly: Story = {
  globals: { locale: 'ja' },
  args: { author: { ...carol, displayName: null, handle } },
  play: observe,
};
export const DisplayNameOnly: Story = {
  globals: {},
  args: { author: { ...carol, displayName, handle: null } },
  play: observe,
};
export const CarolKeyboardTarget: Story = { args: { author: carol, size: 'sm' }, play: observe };
export const HandleKeyboardTarget: Story = {
  args: { author: { ...carol, displayName: null, handle: 'c' } },
  play: observe,
};
export const WithAvatar: Story = {
  args: { author: { ...carol, avatar } },
  play: async (context) => {
    await observe(context);
    await waitFor(async () => {
      const image = context.canvasElement.querySelector('[data-slot="avatar-image"]');
      await expect(image).toHaveAttribute('src', `/media/${avatar.media}/webp-320`);
      await expect(image).toHaveAttribute('alt', '');
      await expect(image).toHaveAttribute('loading', 'lazy');
    });
  },
};
export const NoAvatar: Story = {
  args: { author: carol, createdAt: '2026-10-01T11:00:00.000Z' },
  play: async (context) => {
    await observe(context);
    await expect(context.canvasElement.querySelector('img')).toBeNull();
    await expect(context.canvasElement.querySelector('[data-slot="avatar-fallback"]')).toHaveTextContent('C');
  },
};
export const IdentityPrivacy: Story = {
  globals: {},
  render: () => (
    <main id="thread" className="mx-auto min-w-0 max-w-3xl space-y-6 p-4">
      {privacy.map(({ label, author }) => (
        <section key={label} data-private-case>
          <h2 className="mb-2 font-medium">{label}</h2>
          <Byline author={author} createdAt={createdAt} now={now} />
        </section>
      ))}
      <section data-hidden-case>
        <h2 className="mb-2 font-medium">Author suppressed by the caller</h2>
        <Byline author={{ ...carol, ...poison }} createdAt={createdAt} now={now} showAuthor={false} />
      </section>
      <section data-automated-case>
        <h2 className="mb-2 font-medium">Admitted public automated identity</h2>
        <Byline author={{ ...carol, automated: true, operatorId: poison.operatorId }} createdAt={createdAt} now={now} />
      </section>
    </main>
  ),
  play: async ({ canvasElement }) => {
    for (const [index, row] of [...canvasElement.querySelectorAll('[data-private-case]')].entries()) {
      await expect(within(row as HTMLElement).getByText(privacy[index]!.text(), { exact: true })).toBeVisible();
      await expect(row.querySelector('a, img, [title]:not(time)')).toBeNull();
      await expect(row.querySelector('[data-slot="avatar-fallback"]')).toHaveTextContent('?');
    }
    for (const text of Object.values(poison).filter((value) => typeof value === 'string'))
      await expect(canvasElement.innerHTML).not.toContain(text);
    await expect(canvasElement.innerHTML).not.toContain(poison.avatar.media);
    const hidden = canvasElement.querySelector('[data-hidden-case]')!;
    await expect(hidden.querySelector('a, img, [data-slot="avatar"], [title]:not(time)')).toBeNull();
    await expect(hidden.querySelector('time')).toHaveAttribute('datetime', createdAt);
    await expect(canvasElement.querySelector('[data-automated-case] a')).toHaveAttribute(
      'href',
      `/${getLocale()}/@carol`,
    );
  },
};

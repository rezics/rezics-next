import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PageAuthor } from '../src/identity/read';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { Byline, fullDateTime, timeText } from '../src/threads/byline';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const createdAt = '2026-11-02T11:00:00.000Z';
const revisedAt = '2026-11-02T11:30:00.000Z';
const now = '2026-11-02T12:00:00.000Z';
const carol = {
  id: '01a17a3a-20f5-72aa-9f14-f4cc56678188',
  kind: 'actor',
  state: 'active',
  displayName: 'Carol',
  handle: 'carol',
  automated: false,
  operatorId: null,
} satisfies PageAuthor;
const poison = {
  displayName: 'POISONED PRIVATE NAME',
  handle: 'poisoned-private-handle',
  avatarUrl: 'https://poisoned-private-image.invalid/avatar',
  avatar: {
    media: 'poisoned-private-image',
    width: 48,
    height: 48,
    variants: [{ format: 'webp' as const, width: 48 }],
    placeholder: { color: '#123456', thumbhash: 'poisoned-private-placeholder' },
    focalPoint: null,
    credit: null,
  },
  automated: true,
  operatorId: 'poisoned-private-operator',
};

function render(props: Partial<ComponentProps<typeof Byline>> = {}) {
  const window = new Window();
  const html = renderToStaticMarkup(
    <main id="thread">
      <Byline author={carol} createdAt={createdAt} now={now} {...props} />
    </main>,
  );
  window.document.body.innerHTML = html;
  return { html, body: window.document.body };
}

// UNRUN under MINIMAL. These actual-component observations cover supplied presentation only;
// CSS geometry, keyboard focus, loaded media and native/full acceptance remain browser/integration work.
describe('Complete readable author bylines', () => {
  test('long admitted names and handles remain complete with the exact locale and encoded own profile link', () => {
    const previous = getLocale();
    const displayName = `Readers 共讀 العربية ${'UnbrokenSuppliedName'.repeat(6)} <ordinary text>`;
    const handle = `carol/+雪?=${'long_handle_'.repeat(12)}`;
    try {
      for (const locale of ['en', 'ja', 'fr'] as const) {
        setLocale(locale, { reload: false });
        for (const name of [displayName, null]) {
          const { body } = render({ author: { ...carol, displayName: name, handle } });
          const identity = body.querySelector('#thread p > span > span')!;
          expect(identity.textContent).toBe(name ? `${name} @${handle}` : `@${handle}`);
          expect(identity.getAttribute('title')).toBe(name ? `${name} @${handle}` : `@${handle}`);
          const links = [...identity.querySelectorAll('a')];
          expect(links).toHaveLength(1);
          expect(links[0]!.getAttribute('href')).toBe(`/${locale}/@${encodeURIComponent(handle)}`);
          expect(links[0]!.textContent).toBe(name ?? `@${handle}`);
          expect(identity.querySelector('ordinary')).toBeNull();
          expect(identity.querySelector('a a, button, [tabindex]')).toBeNull();
        }
        expect(render().body.querySelector('a')?.getAttribute('href')).toBe(`/${locale}/@carol`);
      }
    } finally {
      setLocale(previous, { reload: false });
    }
  });

  test('a display name without a handle stays visible without inventing a profile destination', () => {
    const displayName = 'A supplied name without a handle 共讀 العربية';
    const { body } = render({ author: { ...carol, displayName, handle: null } });
    expect(body.querySelector('#thread p > span > span')?.textContent).toBe(displayName);
    expect(body.querySelector('a')).toBeNull();
    expect(body.querySelector('[data-slot="avatar"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('deleted people, deleted organizations and unknown automated identities reveal no poisoned fields or titles', () => {
    const cases = [
      { author: undefined, label: m.thread_author_unknown() },
      {
        author: { ...carol, ...poison, displayName: null, handle: null },
        label: m.thread_author_unknown(),
      },
      ...(['actor', 'organization'] as const).map((kind) => ({
        author: { ...carol, ...poison, state: 'deleted', kind } as unknown as PageAuthor,
        label: kind === 'organization' ? m.thread_author_deleted_organization() : m.thread_author_deleted(),
      })),
    ];
    for (const { author, label } of cases) {
      const { body, html } = render({ author });
      const identity = body.querySelector('#thread p > span > span')!;
      expect(identity.textContent).toBe(label);
      expect(identity.hasAttribute('title')).toBe(false);
      expect(body.querySelector('a, img, [title]:not(time)')).toBeNull();
      expect(body.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('?');
      for (const fragment of [
        poison.displayName,
        poison.handle,
        poison.avatarUrl,
        poison.avatar.media,
        poison.avatar.placeholder.thumbhash,
        poison.operatorId,
      ])
        expect(html).not.toContain(fragment);
      expect(body.querySelector('time')?.getAttribute('datetime')).toBe(createdAt);
    }
  });

  test('public automation retains admitted identity while operator data remains absent', () => {
    const { body, html } = render({ author: { ...carol, automated: true, operatorId: poison.operatorId } });
    expect(body.querySelector('a')?.textContent).toBe('Carol');
    expect(body.querySelector('a')?.getAttribute('href')).toBe(`/${getLocale()}/@carol`);
    expect(html).not.toContain(poison.operatorId);
  });

  test('the caller can suppress all author presentation while retaining exact metadata and children', () => {
    const { body, html } = render({
      author: { ...carol, ...poison },
      showAuthor: false,
      children: (
        <time dateTime={revisedAt} title="Supplied full edit time">
          Supplied edit label
        </time>
      ),
    });
    expect(body.querySelector('a, img, [data-slot="avatar"], [title]:not(time)')).toBeNull();
    for (const fragment of [poison.displayName, poison.handle, poison.avatar.media, poison.operatorId])
      expect(html).not.toContain(fragment);
    expect([...body.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toEqual([
      createdAt,
      revisedAt,
    ]);
    expect(body.querySelectorAll('time')[1]!.getAttribute('title')).toBe('Supplied full edit time');
    expect(body.textContent).toContain('Supplied edit label');
  });

  test('compact and default avatars retain their decorative fallback without changing metadata descendant shape', () => {
    for (const size of ['default', 'sm'] as const) {
      const { body } = render({
        size,
        children: (
          <time dateTime={revisedAt} title="Supplied edit time">
            Supplied edit label
          </time>
        ),
      });
      const portrait = body.querySelector('[data-slot="avatar"]')!;
      expect(portrait.getAttribute('data-size')).toBe(size);
      expect(portrait.getAttribute('aria-hidden')).toBe('true');
      expect(body.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('C');
      expect(body.querySelector('img')).toBeNull();
      const row = body.querySelector('#thread p > span')!;
      expect(row.children).toHaveLength(2);
      const metadata = row.lastElementChild!;
      expect(metadata.tagName).toBe('SPAN');
      expect(metadata.children).toHaveLength(2);
      const times = [...metadata.querySelectorAll('time')];
      expect(times.map((time) => time.getAttribute('datetime'))).toEqual([createdAt, revisedAt]);
      const separator = metadata.querySelector('[aria-hidden="true"]')!;
      expect(separator.textContent).toBe('\u00b7');
      expect(separator.previousSibling?.textContent).toBe(' ');
      expect(separator.nextSibling?.textContent).toBe('\u00a0');
      expect(separator.parentElement?.contains(times[1]!)).toBe(true);
      expect(row.querySelector('[data-slot="content-item-frame"]')).toBeNull();
    }
    expect(render().body.querySelectorAll('p > span > span:last-child > span')).toHaveLength(1);
  });

  test('relative, full and older dates keep the native rounding, seven-day boundary and UTC formatting', () => {
    const previous = getLocale();
    try {
      for (const locale of ['en', 'ja', 'fr'] as const) {
        setLocale(locale, { reload: false });
        for (const [date, unit, value] of [
          ['2026-11-02T11:59:45.000Z', 'second', -15],
          ['2026-11-02T11:30:00.000Z', 'minute', -30],
          [createdAt, 'hour', -1],
          ['2026-10-26T12:00:00.000Z', 'day', -7],
          ['2026-11-03T12:00:00.000Z', 'day', 1],
        ] as const) {
          expect(timeText(date, now, locale)).toBe(
            new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit),
          );
        }
        const older = '2026-10-26T11:59:59.999Z';
        const { body } = render({ createdAt: older });
        const date = body.querySelector('time')!;
        expect(date.textContent).toBe(
          new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(older)),
        );
        const full = new Intl.DateTimeFormat(locale, {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: 'UTC',
        }).format(new Date(older));
        expect(date.getAttribute('datetime')).toBe(older);
        expect(date.getAttribute('title')).toBe(full);
        expect(fullDateTime(older, locale)).toBe(full);
      }
    } finally {
      setLocale(previous, { reload: false });
    }
  });
});

import { expect, test } from 'bun:test';
import { act } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { id } from '../src/stories/exact-revision/fixture';
import { mount, runtime, flush, selected, getLocale, setLocale } from './support/post-history-current';

test('actual session/account/CSRF replacements retire disclosure and delayed responses including observed ABA', async () => {
  for (const replacement of [
    { state: 'signed-out', subject: null, csrfToken: null },
    { state: 'signed-in', subject: id(91), csrfToken: null },
    { state: 'signed-in', subject: selected.authorId, csrfToken: 'new-csrf' },
  ]) {
    const view = await mount();
    try {
      runtime.subject = selected.authorId;
      runtime.envelope.page.viewer = { kind: 'account', id: selected.authorId };
      const original = { state: 'signed-in', subject: selected.authorId, csrfToken: null };
      await act(async () => {
        view.client.setQueryData(['session'], original);
        await flush();
      });
      await view.open();
      await view.inspect();
      expect(runtime.calls[0]!.headers.get('authorization')).toBe('Bearer current-history-token');
      await act(async () => {
        view.client.setQueryData(['session'], replacement);
        view.client.setQueryData(['session'], original);
        await flush();
      });
      expect(view.host.textContent).not.toContain('Admitted conversation');
      expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    } finally {
      await view.dispose();
    }
  }
});

test('post, thread, exposure, locale and QueryClient source replacements retire on their first render', async () => {
  for (const replacement of ['post', 'thread', 'exposure', 'locale', 'source'] as const) {
    const view = await mount();
    const source = new QueryClient();
    source.setQueryData(['session'], { state: 'signed-out' });
    try {
      await view.open();
      await view.inspect();
      if (replacement === 'locale') {
        await act(async () => {
          window.history.replaceState(null, '', '/zh-Hant/threads/current');
          setLocale('zh-Hant', { reload: false });
          await flush();
        });
        expect(getLocale()).toBe('zh-Hant');
      }
      await view.render(
        replacement === 'post'
          ? { postId: id(99) }
          : replacement === 'thread'
            ? { threadId: id(99) }
            : replacement === 'exposure'
              ? { exposure: {} }
              : {},
        replacement === 'source' ? source : view.client,
      );
      expect(view.host.textContent).not.toContain('Admitted conversation');
      expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    } finally {
      source.clear();
      await view.dispose();
    }
  }
});

test('an obsolete delayed page cannot disclose after source replacement and return', async () => {
  const view = await mount();
  const other = new QueryClient();
  other.setQueryData(['session'], { state: 'signed-out' });
  try {
    runtime.defer = true;
    await view.open();
    await view.render({}, other);
    await view.render({}, view.client);
    await view.finish();
    expect(view.host.textContent).not.toContain('Admitted conversation');
    expect(view.host.querySelector('[data-history-summary]')).toBeNull();
    expect(runtime.calls).toHaveLength(1);
  } finally {
    other.clear();
    await view.dispose();
  }
});

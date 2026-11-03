import { expect, test } from 'bun:test';
import { mount, runtime, click, control, m, later } from './support/post-history-current';

test('exact and admitted comparison destinations retain immutable selection and return focus', async () => {
  const view = await mount();
  try {
    await view.open();
    await view.inspect();
    const exact = view.host.querySelector<HTMLAnchorElement>('[data-history-inspector] footer a')!;
    expect(exact.getAttribute('target')).toBe('_blank');
    expect(exact.href).toContain(runtime.envelope.revisions[0]!.revisionId);
    const compare = control(view.host, m.post_history_compare());
    compare.focus();
    await click(compare);
    expect(runtime.calls.filter((request) => request.url.endsWith(`/revisions/${later.revisionId}`))).toHaveLength(1);
    expect(view.host.textContent).toContain('The later edition makes the ending more explicit.');
    expect(view.host.querySelector('[data-history-selected]')).not.toBeNull();
    await click(control(view.host, m.post_history_comparison_close()));
    expect(document.activeElement).toBe(compare);
    expect(view.host.textContent).not.toContain('The later edition makes the ending more explicit.');
    expect(view.host.querySelector('[data-history-selected]')).not.toBeNull();
    expect(runtime.calls.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    await view.dispose();
  }
});

test('a replacing page retires selection and native comparison destinations before its delayed response', async () => {
  const view = await mount();
  try {
    runtime.envelope.next = 'opaque/+=cursor';
    await view.open();
    await view.inspect();
    runtime.defer = true;
    await click(control(view.host, m.thread_history_more()));
    expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    expect(view.host.textContent).not.toContain('Admitted conversation');
    expect(new URL(runtime.calls.at(-1)!.url).searchParams.get('cursor')).toBe('opaque/+=cursor');
    await view.finish();
    expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    expect(view.host.querySelectorAll('[data-history-summary]')).toHaveLength(1);
  } finally {
    await view.dispose();
  }
});

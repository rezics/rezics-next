import { expect, test } from 'bun:test';
import { OwnedApplicationReview } from '../src/owned-application-review-view';
import { permissionDescription } from '../src/permission-description';
import {
  button,
  click,
  expand,
  host,
  inventory,
  m,
  ready,
  render,
  row,
  text,
  tick,
  type Page,
} from './owned-application-review-fixture';

test('public identity, ordered capabilities, duplicate names and local disclosure/copy', async () => {
  const longId = `client-読書-${'長い識別子'.repeat(40)}`;
  const scopes = ['unfamiliar:future', 'subject:read', `scope:${'long'.repeat(80)}`];
  const data = inventory({
    kind: 'ready',
    rows: [
      row('same-1'),
      row('same-2'),
      row(longId, { display_name: '  ', disabled: true, scopes: [] }),
      row('literal', { display_name: '<b>読書</b>', scopes }),
    ],
    next: null,
  });
  const copied: string[] = [];
  await render(
    <OwnedApplicationReview
      source={data.source}
      copyIdentifier={async (id) => {
        copied.push(id);
      }}
    />,
  );
  expect(
    [...host.querySelectorAll('[data-owned-control]')].map((control) => control.getAttribute('aria-label')),
  ).toEqual([
    m.auth_owned_details_for({ name: 'Reading companion', identifier: 'same-1' }),
    m.auth_owned_details_for({ name: 'Reading companion', identifier: 'same-2' }),
    m.auth_owned_details_for({ name: m.auth_inventory_unnamed(), identifier: longId }),
    m.auth_owned_details_for({ name: '<b>読書</b>', identifier: 'literal' }),
  ]);
  expect(text()).toContain(m.auth_owned_description());
  await expand(2);
  expect(text()).toContain(m.auth_owned_disabled());
  expect(text()).toContain(m.auth_owned_scopes_empty());
  expect(text()).toContain(m.auth_owned_disabled_note());
  await click(m.auth_owned_copy());
  expect(copied).toEqual([longId]);
  expect(text()).toContain(m.auth_owned_copied());
  await click(m.auth_owned_close());
  expect(document.activeElement).toBe(host.querySelectorAll('[data-owned-control]')[2]);
  expect(text()).not.toContain(m.auth_owned_copied());
  await expand(3);
  const region = host.querySelector('[role="region"]')!;
  expect([...region.querySelectorAll('ul code')].map((code) => code.textContent)).toEqual(scopes);
  expect(region.textContent).toContain(permissionDescription(scopes[0]!).detail);
  expect(region.textContent).toContain(m.auth_owned_capabilities());
  expect(host.querySelector('b,a,img')).toBeNull();
  expect(data.cursors()).toEqual([undefined]);
  const control = host.querySelector('[aria-expanded="true"]')!;
  expect(region.id).toBe(control.getAttribute('aria-controls'));
  expect(document.activeElement?.tagName).toBe('H3');
});

test('held Next gates duplicate activation; exact retry commits history only once', async () => {
  const held = Promise.withResolvers<Page>();
  const next = 'signed/opaque?A=1+2';
  const data = inventory(
    ready('page-first-id', next),
    held.promise,
    { kind: 'unavailable' },
    ready('second', 'next-B'),
    ready('page-first-id', next),
  );
  await render(<OwnedApplicationReview source={data.source} />);
  await expand();
  const nextButton = button(m.auth_inventory_next());
  await tick(() => {
    nextButton.click();
    nextButton.click();
  });
  expect(data.cursors()).toEqual([undefined, next]);
  expect(text()).toContain(m.auth_inventory_loading());
  expect(text()).not.toContain('page-first-id');
  expect(host.querySelector('[role="region"]')).toBeNull();
  expect(document.activeElement?.tagName).toBe('H2');
  await tick(() => held.resolve({ kind: 'unavailable' }));
  expect(text()).toContain(m.auth_inventory_unavailable());
  expect(text()).not.toContain(m.auth_inventory_previous());
  await click(m.auth_owned_retry());
  await click(m.auth_owned_retry());
  expect(text()).toContain('second');
  await click(m.auth_inventory_previous());
  expect(data.cursors()).toEqual([undefined, next, next, next, undefined]);
  expect(text()).toContain('page-first-id');
  expect(text()).not.toContain(m.auth_inventory_previous());
});

test('failed Next leaves accepted Previous/Reload targets; expired cursor needs explicit restart', async () => {
  const data = inventory(
    ready('first', 'A'),
    ready('second', 'B'),
    { kind: 'denied' },
    ready('second', 'B'),
    { kind: 'expired' },
    ready('first'),
    ready('first'),
  );
  await render(<OwnedApplicationReview source={data.source} />);
  await click(m.auth_inventory_next());
  await click(m.auth_inventory_next());
  expect(text()).toContain(m.auth_inventory_denied());
  await click(m.auth_owned_reload());
  expect(data.cursors()).toEqual([undefined, 'A', 'B', 'A']);
  await click(m.auth_inventory_previous());
  expect(text()).toContain(m.auth_owned_expired());
  expect(text()).not.toContain('second');
  expect(data.cursors()).toEqual([undefined, 'A', 'B', 'A', undefined]);
  await click(m.auth_owned_restart());
  expect(text()).not.toContain(m.auth_inventory_previous());
  await click(m.auth_owned_reload());
  expect(data.cursors()).toEqual([undefined, 'A', 'B', 'A', undefined, undefined, undefined]);
});

test('late clipboard after collapse/navigation never announces in another disclosure; unavailable stays selectable', async () => {
  const copy = Promise.withResolvers<void>();
  const data = inventory(ready('first', 'A'), ready('second'));
  const props = { source: data.source, copyIdentifier: () => copy.promise };
  await render(<OwnedApplicationReview {...props} />);
  await expand();
  await click(m.auth_owned_copy());
  await click(m.auth_owned_close());
  await expand();
  await tick(() => copy.resolve());
  expect(text()).not.toContain(m.auth_owned_copied());
  await click(m.auth_inventory_next());
  await expand();
  await render(
    <OwnedApplicationReview
      {...props}
      copyIdentifier={async () => {
        throw new Error('Unavailable');
      }}
    />,
  );
  await click(m.auth_owned_copy());
  expect(text()).toContain(m.auth_owned_copy_failed());
  expect(host.querySelector('[role="region"] code')?.textContent).toBe('second');
  expect(data.cursors()).toEqual([undefined, 'A']);
});

test('retirement synchronously removes private DOM; replacement and aborted lifetimes fence delayed reads/copy', async () => {
  const life = new AbortController();
  const heldRead = Promise.withResolvers<Page>();
  const heldCopy = Promise.withResolvers<void>();
  const old = inventory(ready('private-old', 'old-cursor'), heldRead.promise);
  await render(
    <OwnedApplicationReview source={old.source} lifetime={life.signal} copyIdentifier={() => heldCopy.promise} />,
  );
  await expand();
  await click(m.auth_owned_copy());
  await tick(() => {
    life.abort();
    expect(text()).not.toContain('private-old');
    expect(host.querySelector('nav,[role="region"]')).toBeNull();
  });
  await tick(() => heldCopy.resolve());
  expect(text()).not.toContain(m.auth_owned_copied());
  const alreadyAborted = inventory(ready('forbidden'));
  await render(<OwnedApplicationReview source={alreadyAborted.source} lifetime={life.signal} />);
  expect(alreadyAborted.calls).toHaveLength(0);
  const freshLife = new AbortController();
  await render(<OwnedApplicationReview source={old.source} lifetime={freshLife.signal} />);
  const replacement = inventory(ready('new-observation'));
  await render(<OwnedApplicationReview source={replacement.source} lifetime={freshLife.signal} />);
  expect(old.calls[1]!.signal?.aborted).toBe(true);
  await tick(() => heldRead.resolve(ready('late-old')));
  expect(text()).toContain('new-observation');
  expect(text()).not.toContain('late-old');
  expect(replacement.cursors()).toEqual([undefined]);
});

test('empty and each failed category remain distinct without automatic reads', async () => {
  for (const kind of ['signed-out', 'denied', 'unavailable', 'expired'] as const) {
    const data = inventory({ kind });
    await render(<OwnedApplicationReview source={data.source} />);
    expect(text()).not.toContain(m.auth_owned_empty());
    expect(button(m.auth_owned_retry())).toBeTruthy();
    expect(data.calls).toHaveLength(1);
  }
  const empty = inventory({ kind: 'ready', rows: [], next: 'opaque-next' });
  await render(<OwnedApplicationReview source={empty.source} />);
  expect(text()).toContain(m.auth_owned_empty());
  expect(text()).toContain(m.auth_owned_page_count({ count: 0 }));
  expect(text()).toContain(m.auth_owned_next_available());
  expect(button(m.auth_inventory_next())).toBeTruthy();
});

test('source replacement clears expanded copy feedback; abort and unmount fence ignored cancellation', async () => {
  const copy = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Page>();
  const life = new AbortController();
  const old = inventory(ready('old-private'));
  await render(
    <OwnedApplicationReview source={old.source} lifetime={life.signal} copyIdentifier={() => copy.promise} />,
  );
  await expand();
  await click(m.auth_owned_copy());
  const fresh = inventory(ready('new-private'), delayed.promise);
  await render(<OwnedApplicationReview source={fresh.source} lifetime={life.signal} />);
  expect(text()).not.toContain('old-private');
  expect(document.activeElement?.tagName).toBe('H2');
  await tick(() => copy.resolve());
  expect(text()).not.toContain(m.auth_owned_copied());
  await click(m.auth_owned_reload());
  await tick(() => {
    life.abort();
    expect(host.querySelector('nav')).toBeNull();
  });
  await tick(() => delayed.resolve(ready('late-private')));
  expect(text()).not.toContain('late-private');
  const unmounted = Promise.withResolvers<Page>();
  const data = inventory(unmounted.promise);
  await render(<OwnedApplicationReview source={data.source} />);
  await render(null);
  expect(data.calls[0]!.signal?.aborted).toBe(true);
  await tick(() => unmounted.resolve(ready('unmounted-private')));
  expect(text()).toBe('');
});

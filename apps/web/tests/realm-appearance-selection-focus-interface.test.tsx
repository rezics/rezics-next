import { afterAll, expect, mock, test } from 'bun:test';
import { act, createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import type {
  RealmAppearanceAdapter,
  RealmAppearanceChoice,
  RealmAppearanceRead,
  RealmAppearanceSelection,
} from '../src/community/realm-presentation';
import { available, image, revisionId } from '../src/kernel/fake/community';

const { Window } = await import(Bun.resolveSync('happy-dom', import.meta.dir));
const window = new Window({ url: 'https://site.test/en/spaces/quiet-novel-club-appearance' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  Event: window.Event,
  Element: window.Element,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('../src/community/realm-appearance-departure', () => ({
  RealmAppearanceDeparture: ({ children }: { children: ReactNode }) => children,
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const [{ createRoot }, { within, userEvent }, { RealmAppearanceSettings }, { m }] = await Promise.all([
  import('react-dom/client'),
  import('storybook/test'),
  import('../src/community/realm-presentation-settings'),
  import('../src/paraglide/messages.js'),
]);

function candidate(choice: RealmAppearanceChoice): RealmAppearanceSelection {
  return choice.kind === 'rules'
    ? {
        kind: 'rules',
        rules: {
          postId: choice.postId,
          revisionId: choice.revisionId,
          title: 'Community rules',
          summary: 'Local rules.',
        },
      }
    : { kind: 'image', image: { ...image, id: choice.mediaId, containerId: choice.realmId } };
}
let pendingSelection: Promise<RealmAppearanceSelection> | null = null;
let changes = 0;
const adapter: RealmAppearanceAdapter = {
  read: async () => ({ kind: 'ready', snapshot: available }),
  change: async () => {
    changes++;
    return { kind: 'unavailable' };
  },
  select: async (choice) => pendingSelection ?? candidate(choice),
  upload: async () => ({ id: image.id }),
  resume: async (mediaId) => ({ id: mediaId }),
};
const host = window.document.createElement('main');
window.document.body.append(host);
const user = userEvent.setup({ document: window.document as unknown as Document });
let root: Root | undefined;
const paint = (initial: RealmAppearanceRead = { kind: 'ready', snapshot: available }) =>
  act(async () =>
    root!.render(createElement(RealmAppearanceSettings, { realmId: available.realmId, initial, adapter })),
  );
const selector = (index: number) => within(host).getAllByRole('button', { name: m.realm_appearance_choose() })[index]!;

afterAll(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  window.happyDOM.abort();
});

test('appearance selection and clear review keep focus on the matching slot controls', async () => {
  root = createRoot(host);
  await paint();
  const slots = [
    {
      choose: selector(0),
      chooseButton: m.realm_appearance_choose(),
      field: m.realm_appearance_image_link(),
      href: `/media/${image.id}/webp-640`,
      clearIndex: 0,
    },
    {
      choose: selector(1),
      chooseButton: m.realm_appearance_choose(),
      field: m.realm_appearance_image_link(),
      href: `/media/${image.id}/webp-640`,
      clearIndex: 1,
    },
    {
      choose: within(host).getByRole('button', { name: m.realm_appearance_select_rules() }),
      chooseButton: m.realm_appearance_select_rules(),
      field: m.realm_appearance_rules_link(),
      href: `/posts/${image.id}/revisions/${revisionId}`,
      clearIndex: 2,
    },
  ];
  for (const slot of slots) {
    slot.choose.focus();
    await user.keyboard('{Enter}');
    const field = within(host).getByRole('textbox', { name: slot.field });
    expect(window.document.activeElement).toBe(field);
    await user.type(field, slot.href);
    await user.click(within(host).getByRole('button', { name: m.realm_appearance_preview() }));
    await user.click(await within(host).findByRole('button', { name: m.realm_appearance_use_selection() }));
    expect(window.document.activeElement).toBe(slot.choose);

    slot.choose.focus();
    await user.keyboard('{Enter}');
    await user.click(within(host).getByRole('button', { name: m.editor_cancel() }));
    expect(window.document.activeElement).toBe(slot.choose);

    const clear = within(host).getAllByRole('button', { name: m.realm_appearance_clear() })[slot.clearIndex]!;
    clear.focus();
    await user.keyboard('{Enter}');
    const review = within(host).getByRole('group', { name: m.realm_appearance_clear_confirm() });
    expect(window.document.activeElement).toBe(review);
    await user.click(within(review).getByRole('button', { name: m.editor_cancel() }));
    expect(window.document.activeElement).toBe(clear);

    clear.focus();
    await user.keyboard('{Enter}');
    await user.click(
      within(within(host).getByRole('group', { name: m.realm_appearance_clear_confirm() })).getByRole('button', {
        name: m.realm_appearance_clear(),
      }),
    );
    expect(window.document.activeElement).toBe(slot.choose);
  }
  expect(changes).toBe(0);
});

test('a selection retired by a newer head cannot steal deliberately moved focus when it resolves late', async () => {
  root ??= createRoot(host);
  await paint();
  const outside = window.document.createElement('button');
  outside.textContent = 'Focus target';
  window.document.body.append(outside);
  let resolve!: (selection: RealmAppearanceSelection) => void;
  pendingSelection = new Promise((done) => (resolve = done));
  const rulesButton = within(host).getByRole('button', { name: m.realm_appearance_select_rules() });
  rulesButton.focus();
  await user.keyboard('{Enter}');
  await user.type(
    within(host).getByRole('textbox', { name: m.realm_appearance_rules_link() }),
    `/posts/${image.id}/revisions/${revisionId}`,
  );
  await user.click(within(host).getByRole('button', { name: m.realm_appearance_preview() }));
  outside.focus();
  await paint({ kind: 'ready', snapshot: { ...available, head: '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0099' } });
  expect(window.document.activeElement).toBe(outside);
  resolve(candidate({ kind: 'rules', realmId: available.realmId, postId: image.id, revisionId }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(window.document.activeElement).toBe(outside);
  expect(within(host).queryByRole('textbox', { name: m.realm_appearance_rules_link() })).toBeNull();
  pendingSelection = null;
  outside.remove();
});

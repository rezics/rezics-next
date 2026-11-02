import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import { PresentationViewEditor, type CurationEditorTransport } from '../features/pages/curate-view-editor';
import { m } from '../paraglide/messages.js';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

// Explicit inert profile data exercises the real editor. These are behavior states, not native publication receipts.
const pageDocument = (id: string, level = 2): CompositionDocument => ({
  root: { props: { appearance: { density: 'comfortable' } } },
  content: [
    {
      type: 'Heading',
      props: {
        id,
        level,
        text: {
          en: 'Reading notes',
          'zh-Hans': '阅读笔记',
          'zh-Hant': '閱讀筆記',
          ja: '読書ノート',
          ko: '독서 노트',
          de: 'Lesenotizen',
          es: 'Notas de lectura',
          fr: 'Notes de lecture',
        },
      },
    },
  ],
});
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: pageDocument('generic'),
      relations: pageDocument('generic-relations'),
      details: pageDocument('generic-details'),
    },
  },
  bases: [
    { base: 'schema:CreativeWork', views: { overview: pageDocument('work', 1), credits: pageDocument('credits', 3) } },
  ],
  types: [
    {
      type: 'schema:Book',
      views: {
        overview: pageDocument('book'),
        editions: pageDocument('editions', 4),
        details: pageDocument('details'),
      },
    },
  ],
  routes: [{ route: '/', document: pageDocument('home', 1) }],
};
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const initial = { ok: true as const, reader, profile, digest: profileDigest(profile), head: 7 };
const transport: CurationEditorTransport = {
  read: async () => initial,
  publish: async () => ({ ok: false, reason: 'unavailable' }),
};
const meta = {
  title: 'Pages/Curate/Presentation View Editor',
  component: PresentationViewEditor,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Per-view Puck authoring in the existing shell. Use the shared phone390/desktop1280, locale and theme globals. Failure responses are constructed; these stories do not establish native access or publication proof.',
      },
    },
  },
} satisfies Meta<typeof PresentationViewEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
const render: NonNullable<Story['render']> = (args) => (
  <PatternStory visitor="Signed In" path="/curate/presentation">
    <AppShell>
      <PresentationViewEditor {...args} locale={getLocale()} />
    </AppShell>
  </PatternStory>
);
export const Authoring: Story = {
  args: { initial, locale: 'en', transport },
  render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: `generic: ${m.curation_generic()}` }));
    await expect(await canvas.findByRole('region', { name: m.curation_editor() })).toBeVisible();
  },
};

function templateControls(canvasElement: HTMLElement) {
  const templates = within(canvasElement).getByRole('region', { name: m.curation_templates() });
  const section = within(templates);
  return {
    template: section.getByRole('combobox', { name: m.curation_template() }),
    view: section.getByRole('combobox', { name: m.curation_view() }),
  };
}

function languageFieldLabel(language: string): string {
  return new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language;
}

async function selectDetailsHeading(canvasElement: HTMLElement) {
  const editor = within(canvasElement).getByRole('region', { name: m.curation_editor() });
  const rows = editor.querySelectorAll('[data-puck-layer-tree-id="details"]');
  if (rows.length !== 1) throw new Error('The details Heading is missing from the Puck outline.');
  const row = rows.item(0);
  if (!(row instanceof HTMLElement)) throw new Error('The details Heading outline row did not render.');
  await userEvent.click(within(row).getByRole('button', { name: 'Heading' }));
}

function headingTextField(canvasElement: HTMLElement) {
  const editor = within(canvasElement).getByRole('region', { name: m.curation_editor() });
  return within(editor).findByRole('textbox', { name: languageFieldLabel('en') });
}

// Real Puck field interaction, including an uncommitted edit before switching away and back.
async function editDetails(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const controls = templateControls(canvasElement);
  await userEvent.selectOptions(controls.template, JSON.stringify({ scope: 'type', key: 'schema:Book' }));
  await userEvent.selectOptions(controls.view, 'details');
  await selectDetailsHeading(canvasElement);
  const field = await headingTextField(canvasElement);
  await userEvent.clear(field);
  await userEvent.type(field, 'Retained draft');
  return canvas;
}

export const RetainedViewDraft: Story = {
  ...Authoring,
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.selectOptions(templateControls(canvasElement).view, 'overview');
    await userEvent.selectOptions(
      templateControls(canvasElement).template,
      JSON.stringify({ scope: 'generic', key: null }),
    );
    await userEvent.selectOptions(
      templateControls(canvasElement).template,
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    await userEvent.selectOptions(templateControls(canvasElement).view, 'details');
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
    // Restoring a view restores the document even though Puck's selected block may be reset.
    await selectDetailsHeading(canvasElement);
    await expect(await headingTextField(canvasElement)).toHaveValue('Retained draft');
  },
};

export const StaleProfile: Story = {
  ...Authoring,
  args: { ...Authoring.args, transport: { ...transport, publish: async () => ({ ok: false, reason: 'stale' }) } },
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.curation_publish() }));
    await expect(await canvas.findByText(m.curation_stale())).toBeVisible();
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
    for (const button of canvas.getAllByRole('button', { name: m.curation_publish() })) {
      await expect(button).toBeDisabled();
    }
    await userEvent.click(canvas.getByRole('button', { name: m.curation_view_discard() }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.curation_view_discard() }));
    await expect(canvas.getByText(m.curation_saved())).toBeVisible();
    await expect(canvas.getByText(m.curation_stale())).toBeVisible();
    for (const button of canvas.getAllByRole('button', { name: m.curation_publish() })) {
      await expect(button).toBeDisabled();
    }
  },
};

export const NativeValidation: Story = {
  ...Authoring,
  args: {
    ...Authoring.args,
    transport: {
      ...transport,
      publish: async () => ({
        ok: false,
        reason: 'invalid',
        errors: [{ pointer: '/types/0/views/details/content/0/props/text/en', code: 'invalid' }],
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.curation_publish() }));
    await expect(await canvas.findByText(m.curation_invalid_retained())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.curation_retry_original() })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.curation_correct() }));
    await expect(templateControls(canvasElement).template).toHaveValue(
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    await expect(templateControls(canvasElement).view).toHaveValue('details');
    const field = await headingTextField(canvasElement);
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.clear(field);
    await userEvent.type(field, 'Corrected reading notes');
    await expect(field).toHaveValue('Corrected reading notes');
  },
};

export const DiscardConfirmation: Story = {
  ...Authoring,
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.curation_view_discard() }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(within(dialog).getByText(m.curation_discard_warning())).toBeVisible();
  },
};

export const ReloadUnavailable: Story = {
  ...Authoring,
  args: { ...Authoring.args, transport: { ...transport, read: async () => ({ ok: false, reason: 'unavailable' }) } },
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.curation_reload() }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.curation_discard_reload() }));
    await expect(await canvas.findByText(m.curation_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.curation_unsaved())).toBeVisible();
  },
};

// Known routes let the shell's own links attempt a real departure and unmount this editor.
function DepartureJourney(args: Parameters<typeof PresentationViewEditor>[0]) {
  const locale = getLocale();
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const editor = createRoute({
      getParentRoute: () => root,
      path: '/curate/presentation',
      component: () => (
        <AppShell>
          <PresentationViewEditor {...args} locale={locale} />
        </AppShell>
      ),
    });
    const destination = createRoute({
      getParentRoute: () => root,
      path: '/search',
      component: () => <PageStory visitor="Signed In" path="/search" />,
    });
    return createRouter({
      routeTree: root.addChildren([editor, destination]),
      history: createMemoryHistory({
        initialEntries: [localizeUrl(new URL('/curate/presentation', 'http://rezics.local')).pathname],
      }),
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
  }, [args.initial, args.transport, args.preview, locale]);
  return <RouterProvider router={router} />;
}

export const UnsavedNavigation: Story = {
  ...Authoring,
  render: (args) => (
    <PatternStory visitor="Signed In" path="/curate/presentation">
      <DepartureJourney {...args} />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = await editDetails(canvasElement);
    const searchLink = () =>
      canvas
        .getAllByRole('link', { name: m.nav_search() })
        .find((link) => link.getAttribute('aria-current') !== 'page' && link.getClientRects().length)!;
    const origin = searchLink();
    await userEvent.click(origin);
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('alertdialog', { name: m.curation_leave_title() });
    await expect(dialog).toHaveAccessibleDescription(m.curation_leave_warning());
    await userEvent.click(within(dialog).getByRole('button', { name: m.curation_stay() }));
    await waitFor(() => expect(body.queryByRole('alertdialog')).not.toBeInTheDocument());
    await expect(templateControls(canvasElement).template).toHaveValue(
      JSON.stringify({ scope: 'type', key: 'schema:Book' }),
    );
    await expect(templateControls(canvasElement).view).toHaveValue('details');
    await expect(await headingTextField(canvasElement)).toHaveValue('Retained draft');
    await waitFor(() => expect(origin).toHaveFocus());
    await userEvent.click(searchLink());
    const leaving = await body.findByRole('alertdialog', { name: m.curation_leave_title() });
    await userEvent.click(within(leaving).getByRole('button', { name: m.curation_leave() }));
    await expect(await canvas.findByRole('heading', { level: 1, name: m.search_heading() })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: m.curation_editor() })).not.toBeInTheDocument();
  },
};

// UNRUN constructed control examples; these do not establish native publication or visual acceptance.
const longType = `schema:${'LongTemplate'.repeat(10)}`;
const longRoute = `/${'long-route-key-'.repeat(14)}end`;
const longProfile: PresentationProfile = {
  ...profile,
  types: [
    ...profile.types,
    { type: longType, views: { overview: pageDocument('long-type'), details: pageDocument('long-details') } },
  ],
  routes: [...profile.routes, { route: longRoute, document: pageDocument('long-route') }],
};
const longInitial = { ...initial, profile: longProfile, digest: profileDigest(longProfile) };
const controlsTransport = () => ({ read: fn(transport.read), publish: fn(transport.publish) });

export const IndependentEditors: Story = {
  args: { initial: longInitial, locale: 'en', transport: controlsTransport() },
  render: (args) => (
    <PatternStory visitor="Signed In" path="/curate/presentation">
      <AppShell>
        <div className="grid min-w-0 gap-8 xl:grid-cols-2">
          <div data-editor-example="first" className="min-w-0">
            <PresentationViewEditor {...args} locale={getLocale()} />
          </div>
          <div data-editor-example="second" className="min-w-0">
            <PresentationViewEditor {...args} locale={getLocale()} />
          </div>
        </div>
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement, args }) => {
    const first = canvasElement.querySelector<HTMLElement>('[data-editor-example="first"]')!;
    const second = canvasElement.querySelector<HTMLElement>('[data-editor-example="second"]')!;
    for (const panel of [first, second]) {
      for (const label of panel.querySelectorAll<HTMLLabelElement>('label')) {
        await expect(label.control).not.toBeNull();
        await expect(panel.contains(label.control)).toBe(true);
      }
    }
    const ids = [...canvasElement.querySelectorAll('[id]')].map((node) => node.id);
    await expect(new Set(ids).size).toBe(ids.length);
    await userEvent.selectOptions(templateControls(first).template, JSON.stringify({ scope: 'type', key: longType }));
    await userEvent.selectOptions(templateControls(first).view, 'details');
    await expect(templateControls(second).template).toHaveValue(JSON.stringify({ scope: 'generic', key: null }));
    await expect(templateControls(second).view).toHaveValue('overview');
    await userEvent.click(within(second).getByRole('button', { name: `generic: ${m.curation_generic()}` }));
    await expect(within(first).getByRole('region', { name: m.curation_editor() })).toBeVisible();
    await expect(within(second).getByRole('region', { name: m.curation_editor() })).toBeVisible();
    await userEvent.selectOptions(within(second).getByRole('combobox', { name: m.curation_scope() }), 'route');
    await userEvent.type(within(second).getByRole('textbox', { name: m.curation_key() }), '/second-editor');
    await expect(within(first).getByRole('combobox', { name: m.curation_scope() })).toHaveValue('type');
    await expect(within(first).getByRole('textbox', { name: m.curation_key() })).toHaveValue('');
    await expect(templateControls(first).template).toHaveValue(JSON.stringify({ scope: 'type', key: longType }));
    await expect(templateControls(first).view).toHaveValue('details');
    const mountedIds = [...canvasElement.querySelectorAll('[id]')].map((node) => node.id);
    await expect(new Set(mountedIds).size).toBe(mountedIds.length);
    await expect(args.transport.read).not.toHaveBeenCalled();
    await expect(args.transport.publish).not.toHaveBeenCalled();
  },
};

export const LongKeysPhoneFocus: Story = {
  args: { initial: longInitial, locale: 'en', transport: controlsTransport() },
  render,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      templateControls(canvasElement).template,
      JSON.stringify({ scope: 'route', key: longRoute }),
    );
    await expect(templateControls(canvasElement).view).toHaveValue('overview');
    const selected = canvasElement.ownerDocument.getElementById(
      templateControls(canvasElement).template.getAttribute('aria-describedby')!,
    )!;
    await expect(selected).toHaveTextContent(`${m.curation_route()}: ${longRoute}`);
    await expect(selected).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.curation_close() }));
    const open = canvas.getByRole('button', { name: `route: ${longRoute}` });
    open.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('region', { name: m.curation_editor() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.curation_close() }));
    const summaries = [
      ...templateControls(canvasElement).template.closest('article')!.querySelectorAll<HTMLElement>('summary'),
    ];
    for (const summary of summaries) {
      summary.focus();
      await expect(summary).toHaveFocus();
      await userEvent.keyboard('{Enter}');
      await expect(summary.closest('details')).toHaveAttribute('open');
      await expect(summary).toHaveFocus();
      await userEvent.keyboard(' ');
      await expect(summary.closest('details')).not.toHaveAttribute('open');
    }
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.curation_scope() }), 'route');
    const key = canvas.getByRole('textbox', { name: m.curation_key() });
    await userEvent.type(key, longRoute);
    await expect(key).toHaveValue(longRoute);
    const exactKey = canvasElement.ownerDocument.getElementById(
      key.getAttribute('aria-describedby')!.split(' ').at(-1)!,
    )!;
    await expect(exactKey).toHaveTextContent(longRoute);
    const editor = key.closest('article')!;
    await expect(editor.scrollWidth).toBeLessThanOrEqual(editor.clientWidth);
    for (const control of editor.querySelectorAll<HTMLElement>('select, input, button, summary')) {
      if (!control.getClientRects().length) continue;
      await expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await expect(args.transport.read).not.toHaveBeenCalled();
    await expect(args.transport.publish).not.toHaveBeenCalled();
  },
};

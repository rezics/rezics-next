import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ProviderQueueJourney } from '../features/import-review/provider-queue-journey';
import { sessionQuery } from '../session/query';
import { ProviderQueue } from '../features/import-review/provider-queue-view';
import { providerQueueFixture, type ProviderQueueScenario } from '../kernel/fake/provider-review-queue';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { pickText } from '@rezics/composition';
import { languageName } from '../subject/language';

function QueueStory({
  scenario = 'loaded',
  fixture: supplied,
}: {
  scenario?: ProviderQueueScenario;
  fixture?: ReturnType<typeof providerQueueFixture>;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => supplied ?? providerQueueFixture(scenario), [scenario, locale, supplied]);
  return (
    <PatternStory path="/imports/review" visitor="Signed In">
      <AppShell>
        <ProviderQueue
          key={`${scenario}:${locale}`}
          transport={fixture.transport}
          contexts={fixture.contexts}
          initial={fixture.initial}
          initialScope={fixture.scope}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Imports/Review queue',
  id: 'pages-imports-review-queue',
  component: QueueStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof QueueStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loaded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.prq_status() }), 'accepted_unselected');
    await userEvent.click(canvas.getByRole('button', { name: m.prq_load() }));
    expect(await canvas.findAllByText(m.prq_accepted())).toHaveLength(2);
    expect(canvas.getByRole('button', { name: m.candidate_accept() }).hasAttribute('disabled')).toBe(true);
  },
};
export const Preparing: Story = {
  args: { scenario: 'preparing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.prq_retry() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.prq_continue() }));
    expect(
      await canvas.findByRole('link', {
        name: pickText(providerQueueFixture().native.publicRead.subject.labels, getLocale()).text,
      }),
    ).toBeTruthy();
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(m.prq_empty())).toBeTruthy();
    expect(canvas.getByRole('button', { name: m.prq_refresh() })).toBeEnabled();
    expect(canvas.queryByRole('button', { name: m.candidate_accept() })).toBeNull();
    expect(canvas.queryByText(m.provider_visible_only({ limit: 20 }))).toBeNull();
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).queryByRole('button', { name: m.prq_prepare() })).toBeNull();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.prq_prepare() }));
    expect(await canvas.findByText(m.prq_preparing())).toBeTruthy();
  },
};
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Decision: Story = {
  args: { scenario: 'comparison' },
  loaders: [() => ({ fixture: providerQueueFixture('comparison') })],
  render: (args, { loaded }) => <QueueStory {...args} fixture={loaded.fixture} />,
  play: async ({ canvasElement, loaded }) => {
    const canvas = within(canvasElement);
    const fixture = loaded.fixture as ReturnType<typeof providerQueueFixture>;
    await userEvent.click(canvas.getByRole('button', { name: m.prq_load() }));
    const checkboxes = await canvas.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    const rows = canvas.getAllByRole('listitem').filter((row) => row.hasAttribute('data-slot'));
    expect(rows).toHaveLength(2);
    const identity = pickText(fixture.native.publicRead.subject.labels, getLocale()).text;
    for (const row of rows) expect(within(row).getByRole('link', { name: identity })).toBeVisible();
    expect(within(rows[0]!).getByRole('region', { name: m.context_selected_values() })).toHaveTextContent('1943');
    expect(within(rows[0]!).getByRole('region', { name: m.candidate_proposed() })).toHaveTextContent('1946');
    const languages = within(rows[1]!).getByRole('region', { name: m.context_selected_values() });
    expect(languages).toHaveTextContent(languageName('fr', getLocale())!);
    expect(languages).toHaveTextContent(languageName('en', getLocale())!);
    expect(within(rows[1]!).getByRole('region', { name: m.candidate_proposed() })).toHaveTextContent(
      languageName('de', getLocale())!,
    );
    expect(fixture.calls.filter((call) => call.path.startsWith(`/v1/subjects/${fixture.native.id}?`))).toHaveLength(1);
    expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
    await userEvent.click(checkboxes[1]!);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
    await waitFor(async () => {
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('data-open');
    });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .filter((row) => row.classList.contains('border')),
    ).toHaveLength(1);
    expect(dialog).toHaveTextContent(identity);
    expect(dialog).toHaveTextContent(
      pickText(fixture.native.publicRead.related['schema:inLanguage']!.labels, getLocale()).text,
    );
    expect(dialog).toHaveTextContent(languageName('de', getLocale())!);
    expect(dialog).toHaveTextContent('Q25338');
    expect(dialog).toHaveTextContent('2026-10-31');
    expect(dialog).toHaveTextContent('wikidata-2');
    expect(dialog).not.toHaveTextContent('2026-10-30');
    expect(dialog).not.toHaveTextContent('1946');
    expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: m.provider_confirm_accept() }));
    expect(await canvas.findByText(m.provider_accepted())).toBeTruthy();
    const writes = fixture.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(`/v1/subjects/${fixture.native.id}/candidates/${fixture.suggestions[1]!.id}:accept`);
    expect(writes[0]!.body).toEqual({ context: fixture.scope.context, expected_head: null });
    expect(
      fixture.native.publicRead.subject.statements['schema:inLanguage']!.map((statement) => statement.value),
    ).toEqual([
      { type: 'value', content: 'fr' },
      { type: 'value', content: 'en' },
    ]);
    fixture.setReadingStatus(403);
    await userEvent.click(canvas.getByRole('button', { name: m.prq_refresh() }));
    expect(await canvas.findAllByText(m.provider_missing())).toHaveLength(3);
    expect(canvas.queryByText(identity)).toBeNull();
    expect(canvasElement).not.toHaveTextContent('1943');
    expect(canvasElement).not.toHaveTextContent('Q25338');
  },
};

/** Same mounted production journey/session Query, with the typed generated-native recording seam. UNRUN. */
function NamedQueueStory({ fixture }: { fixture: ReturnType<typeof providerQueueFixture> }) {
  const client = useMemo(() => {
    const value = new QueryClient();
    value.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: fixture.native.id,
      csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    return value;
  }, [fixture]);
  const adapters = useMemo(() => () => ({ transport: fixture.transport, contexts: fixture.contexts }), [fixture]);
  return (
    <PatternStory path="/imports/review" visitor="Signed In">
      <QueryClientProvider client={client}>
        <AppShell>
          <ProviderQueueJourney adapters={adapters} />
        </AppShell>
      </QueryClientProvider>
    </PatternStory>
  );
}
export const NamedCurrentContext: Story = {
  loaders: [() => ({ fixture: providerQueueFixture('comparison') })],
  render: (_args, { loaded }) => (
    <NamedQueueStory fixture={loaded.fixture as ReturnType<typeof providerQueueFixture>} />
  ),
  play: async ({ canvasElement, loaded }) => {
    const fixture = loaded.fixture as ReturnType<typeof providerQueueFixture>;
    const canvas = within(canvasElement);
    const label = pickText(fixture.editorial.labels, getLocale()).text;
    await userEvent.type(canvas.getByRole('combobox', { name: m.prq_source() }), 'wikidata');
    const search = canvas.getByRole('textbox', { name: m.provider_scope_search() });
    await userEvent.type(search, 'Book');
    await userEvent.keyboard('{Enter}');
    const choose = await canvas.findByRole('button', { name: m.provider_scope_choose() });
    await userEvent.click(choose);
    await canvas.findByText(m.provider_scope_selected({ label }));
    await userEvent.click(canvas.getByRole('button', { name: m.prq_load() }));
    const checks = await canvas.findAllByRole('checkbox');
    expect(checks).toHaveLength(2);
    const exact = fixture.calls.filter((call) => call.path === `/v1/contexts/${fixture.editorial.id}/lifecycle`);
    expect(exact).toHaveLength(2); // Choice and independent current resolution before queue.
    const subjectRead = fixture.calls.find((call) => call.path.startsWith(`/v1/subjects/${fixture.native.id}?`))!;
    expect(new URL(subjectRead.path, 'https://queue.test').searchParams.get('context')).toBe(fixture.editorial.id);
    expect(canvasElement).toHaveTextContent(label);
    expect(canvasElement).toHaveTextContent('Wikidata');
    await userEvent.click(checks[0]!);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(label);
    expect(dialog).toHaveTextContent('Wikidata');
    expect(dialog).toHaveTextContent('1946');
    expect(dialog).toHaveTextContent('Q25338');
    await userEvent.tab();
    expect(dialog.contains(canvasElement.ownerDocument.activeElement)).toBe(true);
    expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: m.provider_confirm_accept() }));
    await canvas.findByText(m.provider_accepted());
    const writes = fixture.calls.filter((call) => call.path.endsWith(':accept'));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ context: fixture.editorial.id, expected_head: null });
    expect(canvasElement).toHaveTextContent(label);
    await userEvent.click(canvas.getByRole('button', { name: m.provider_refresh() }));
    expect(fixture.calls.filter((call) => call.path.endsWith(':accept'))).toHaveLength(1);
    expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

export const NamedEnglishPhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'en', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedEnglishDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'en', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedGermanPhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'de', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedGermanDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedSpanishPhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'es', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedSpanishDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'es', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedFrenchPhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'fr', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedFrenchDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'fr', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedJapanesePhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'ja', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedJapaneseDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'ja', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedKoreanPhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'ko', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedKoreanDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'ko', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedSimplifiedChinesePhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'zh-Hans', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedSimplifiedChineseDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'zh-Hans', viewport: { value: 'desktop1280', isRotated: false } },
};

export const NamedTraditionalChinesePhone390: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390', isRotated: false } },
};

export const NamedTraditionalChineseDesktop1280: Story = {
  ...NamedCurrentContext,
  globals: { locale: 'zh-Hant', viewport: { value: 'desktop1280', isRotated: false } },
};

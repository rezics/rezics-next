import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import {
  StatementEditor,
  EditorFailure,
  StatementFields,
  PartValue,
} from '../features/catalogue/statement-editor-view';
import { readStatementEditor, statementInput } from '../features/catalogue/statement-editor';
import { statementFixture, type StatementScenario } from '../kernel/fake/catalogue-statements';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type ExampleProps = {
  scenario?: StatementScenario | 'loading' | 'empty';
  onRequests?: (calls: Readonly<ReturnType<typeof statementFixture>['calls']>) => void;
};

function EditorExample({ scenario, onRequests }: ExampleProps & { scenario: NonNullable<ExampleProps['scenario']> }) {
  const locale = getLocale();
  const fixture = useMemo(
    () => statementFixture(scenario === 'loading' || scenario === 'empty' ? 'ready' : scenario, locale),
    [scenario, locale],
  );
  useEffect(() => {
    onRequests?.(fixture.calls);
  }, [fixture, onRequests]);
  const query = useQuery({
    queryKey: ['correction-story', scenario, locale],
    retry: false,
    queryFn: () =>
      scenario === 'loading'
        ? new Promise<never>(() => {})
        : scenario === 'empty'
          ? readStatementEditor(fixture.client, { id: fixture.id })
          : fixture.editor.read(),
  });
  if (query.isError) return <EditorFailure reason="unavailable" locale={locale} />;
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return (
    <StatementEditor
      key={`${scenario}:${locale}`}
      initial={query.data}
      locale={locale}
      transport={fixture.editor}
      review={() => fixture.review}
    />
  );
}
function Example({ scenario = 'ready', onRequests }: ExampleProps) {
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <EditorExample scenario={scenario} {...(onRequests ? { onRequests } : {})} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Propose correction',
  component: Example,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The subject fact editor uses the generated native client and the existing candidate-review fake. Proposals leave the public statement unchanged. The returned candidate alone opens comparison; acceptance and adoption remain separate confirmations. Use locale, theme and viewport globals for review.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function submit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const year = await canvas.findByRole('textbox', { name: m.correction_year() });
  await userEvent.clear(year);
  await userEvent.type(year, '1946');
  await userEvent.click(await canvas.findByRole('button', { name: m.correction_submit() }));
  return canvas;
}
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.correction_title() });
    const year = await canvas.findByRole('textbox', { name: m.correction_year() });
    await userEvent.clear(year);
    await userEvent.type(year, '1946');
    await expect(year).toHaveValue('1946');
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.correction_empty());
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_denied());
    await expect(canvas.getByRole('textbox', { name: m.correction_year() })).toHaveValue('1946');
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_invalid());
    await expect(canvas.getByRole('textbox', { name: m.correction_year() })).toHaveValue('1946');
  },
};
export const Conflict: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_stale());
    await userEvent.click(canvas.getByRole('button', { name: m.correction_reload() }));
    await expect(canvas.getByRole('textbox', { name: m.correction_year() })).toHaveValue('1946');
  },
};
export const Unavailable: Story = {
  args: { scenario: 'lost-response', onRequests: fn() },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: the default composition at 390px checks actual native targets, label/action wrapping, citation editing, frozen exact retry, comparison, separate acceptance/adoption and saved-reader recovery. Browser, native and visual verification are deferred.',
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('form', { name: m.correction_title() });
    const article = form.closest('article')!;
    const document = canvasElement.ownerDocument;
    await expect(document.documentElement.clientWidth).toBe(390);
    const calls = mocked(args.onRequests!).mock.calls.at(-1)![0];
    const proposals = () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/candidates'));

    // Measure rendered targets and text rectangles, including wrapped translations; no class-name assertions.
    const phoneControls = async () => {
      const bounds = article.getBoundingClientRect();
      await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
      const publicLinks = within(article).queryAllByRole('link', { name: m.candidate_view_public() });
      const targets = [
        ...article.querySelectorAll<HTMLElement>(
          'input:not([type="checkbox"]), select, button[data-slot="button"], a[href$="/details"], [role="status"] a',
        ),
        ...publicLinks,
      ];
      for (const target of targets) {
        const rect = target.getBoundingClientRect();
        const parent = target.parentElement!.getBoundingClientRect();
        await expect(rect.height).toBeGreaterThanOrEqual(44);
        await expect(rect.width).toBeGreaterThanOrEqual(44);
        await expect(rect.left).toBeGreaterThanOrEqual(Math.max(bounds.left, parent.left) - 1);
        await expect(rect.right).toBeLessThanOrEqual(Math.min(bounds.right, parent.right) + 1);
      }
      const labels = [
        ...article.querySelectorAll<HTMLElement>('label, button[data-slot="button"], a[href$="/details"]'),
        ...publicLinks,
      ];
      for (const label of labels) {
        const bounds = label.getBoundingClientRect();
        const walker = document.createTreeWalker(label, 4 /* SHOW_TEXT */);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const line of range.getClientRects()) {
            await expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
            await expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
            await expect(line.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
          }
        }
      }
    };
    await phoneControls();
    const reload = canvas.getByRole('button', { name: m.correction_reload() });
    await userEvent.click(reload);
    await waitFor(() => expect(reload).toBeEnabled());
    await expect(canvas.getByRole('textbox', { name: m.correction_year() })).toHaveValue('1943');

    await userEvent.click(canvas.getByRole('button', { name: m.correction_add_reference() }));
    const addPart = canvas.getAllByRole('combobox', { name: m.correction_add_part() }).at(-1)!;
    await userEvent.selectOptions(addPart, 'schema:url');
    await userEvent.click(
      within(addPart.closest('[data-slot="field"]')!.parentElement!).getByRole('button', { name: m.correction_add() }),
    );
    const citation = 'https://example.com/catalogue/evidence/a-long-publication-record-with-a-preserved-citation';
    await userEvent.type(canvas.getAllByRole('textbox', { name: m.correction_url() }).at(-1)!, citation);
    await phoneControls();
    await submit(canvasElement);
    await canvas.findByText(m.correction_unavailable());
    const year = canvas.getByRole('textbox', { name: m.correction_year() });
    await expect(year).toHaveValue('1946');
    await expect(year).toBeDisabled();
    await expect(canvas.queryByRole('button', { name: m.correction_reload() })).toBeNull();
    await expect(proposals()).toHaveLength(1);
    await phoneControls();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await canvas.findByText(m.correction_proposed());
    await expect(proposals()).toHaveLength(2);
    await expect(proposals()[0]!.key).toBeTruthy();
    await expect(proposals()[1]).toEqual(proposals()[0]);
    await expect(proposals()[0]!.body).toMatchObject({
      statement: {
        value: { content: { time: '+1946-04-06T00:00:00Z', precision: 11 } },
        references: [
          { parts: [{ value: { content: 'https://www.wikidata.org/wiki/Q25338' } }] },
          { parts: [{ property: { id: 'schema:url' }, value: { content: citation } }] },
        ],
      },
    });
    await phoneControls();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_review() }));
    const review = await canvas.findByRole('region', { name: m.candidate_title() });
    const comparison = within(review);
    await comparison.findByRole('heading', { name: m.candidate_proposed() });
    const current = comparison.getByRole('heading', { name: m.candidate_current() }).parentElement!;
    await expect(current).toHaveTextContent('1943');
    await expect(current).not.toHaveTextContent('1946');
    await expect(comparison.getByRole('button', { name: m.candidate_accept() })).toBeEnabled();
    await phoneControls();

    const confirm = async (action: string) => {
      await userEvent.click(comparison.getByRole('button', { name: action }));
      const confirmation = await comparison.findByRole('region', { name: m.candidate_confirm_title({ action }) });
      await expect(confirmation).toHaveFocus();
      await phoneControls();
      await userEvent.click(within(confirmation).getByRole('button', { name: action }));
    };
    await confirm(m.candidate_accept());
    await comparison.findByText(m.candidate_accepted());
    await expect(current).toHaveTextContent('1943');
    await phoneControls();
    await userEvent.click(comparison.getByRole('button', { name: m.candidate_reload() }));
    await waitFor(() => expect(comparison.getByRole('button', { name: m.candidate_reject() })).toBeEnabled());
    const choices = comparison.getAllByRole('checkbox');
    for (const choice of choices) if (choice.getAttribute('aria-checked') === 'true') await userEvent.click(choice);
    await userEvent.click(choices.at(-1)!);
    await confirm(m.candidate_adopt());
    await comparison.findByText(m.candidate_selection_confirmed());
    const savedLink = comparison.getByRole('link', { name: m.candidate_view_public() });
    await expect(savedLink.getAttribute('href')).toContain('/subjects/');
    await expect(comparison.getByRole('heading', { name: m.candidate_current() }).parentElement!).toHaveTextContent(
      '1946',
    );
    await phoneControls();
    await userEvent.click(comparison.getByRole('button', { name: m.candidate_reload() }));
    await waitFor(() => expect(comparison.getByRole('button', { name: m.candidate_close() })).toBeEnabled());
    await expect(comparison.getByRole('heading', { name: m.candidate_current() }).parentElement!).toHaveTextContent(
      '1946',
    );
    await phoneControls();
  },
};
export const Proposed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_proposed());
    await userEvent.click(canvas.getByRole('button', { name: m.correction_review() }));
    await canvas.findByRole('heading', { name: m.candidate_proposed() });
    await expect(canvas.getByRole('button', { name: m.candidate_accept() })).toBeTruthy();
  },
};

export const InvalidDate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const precision = await canvas.findByRole('combobox', { name: m.correction_precision() });
    await userEvent.selectOptions(precision, '11');
    const year = canvas.getByRole('textbox', { name: m.correction_year() });
    await userEvent.clear(year);
    await userEvent.type(year, '1946');
    const month = canvas.getByRole('spinbutton', { name: m.correction_month() });
    await userEvent.clear(month);
    await userEvent.type(month, '2');
    const day = canvas.getByRole('spinbutton', { name: m.correction_day() });
    await userEvent.clear(day);
    await userEvent.type(day, '30');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_submit() }));
    await canvas.findByText(m.correction_error_invalid_format() + ' ' + m.correction_error_date());
  },
};

// Supplied relation fields exercise the same installed family used by creation and relation
// consumers. They do not claim that the standalone scalar-correction route edits relations.
function SuppliedFields({ name }: { name: string }) {
  const locale = getLocale();
  const supplied = useMemo(() => {
    const fixture = statementFixture('ready', locale, 'schema:author');
    const release = structuredClone(fixture.release);
    for (const property of ['schema:author', 'wdt:P1932', 'schema:url']) {
      const definition = release.properties[property]!;
      for (const [language, label] of Object.entries(definition.labels))
        definition.labels[language] = `${label} · ${label} · ${label} · ${label}`;
    }
    const current = { release, public: fixture.publicRead, source: fixture.source };
    const draft = statementInput(fixture.source);
    draft.qualifiers = [
      { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
      { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Antoine de Saint-Exupéry · 原文署名' } },
    ];
    draft.references.push({
      parts: [
        {
          property: { id: 'schema:url' },
          value: { type: 'value', content: 'https://example.org/catalogue/source/complete-publication-evidence' },
        },
        {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { text: 'Le Petit Prince · 完整來源名稱', language: 'fr' } },
        },
        {
          property: { id: 'schema:height' },
          value: {
            type: 'value',
            content: {
              amount: '+1.75',
              unit: 'http://www.wikidata.org/entity/Q11573',
              lowerBound: '+1.74',
              upperBound: '+1.76',
            },
          },
        },
        { property: { id: 'schema:genre' }, value: { type: 'somevalue' } },
      ],
    });
    return { current, draft };
  }, [locale]);
  const [draft, change] = useState(supplied.draft);
  return (
    <section data-family-editor={name} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <h3 className="text-lg font-semibold">{name}</h3>
      <StatementFields
        current={supplied.current}
        draft={draft}
        change={change}
        locale={locale}
        heading="h4"
        valueControl={<PartValue part={draft} read={supplied.current} locale={locale} />}
      />
    </section>
  );
}

function FamilyExample({ rtl = false }: { rtl?: boolean }) {
  const locale = getLocale();
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <div dir={rtl ? 'rtl' : 'ltr'} data-statement-family className="min-w-0">
          <EditorExample scenario="ready" />
          <section className="mx-auto w-full min-w-0 max-w-4xl space-y-6 p-4 sm:p-6">
            <h2 className="text-xl font-semibold">{m.correction_title({}, { locale: locale as never })}</h2>
            <SuppliedFields key={`first:${locale}`} name="A" />
            <SuppliedFields key={`second:${locale}`} name="B" />
          </section>
        </div>
      </AppShell>
    </PatternStory>
  );
}

async function familyJourney(canvasElement: HTMLElement, width: number) {
  const canvas = within(canvasElement);
  await canvas.findByRole('form', { name: m.correction_title() });
  const family = canvasElement.querySelector<HTMLElement>('[data-statement-family]')!;
  const first = family.querySelector<HTMLElement>('[data-family-editor="A"]')!;
  const second = family.querySelector<HTMLElement>('[data-family-editor="B"]')!;
  const document = canvasElement.ownerDocument;
  await expect(document.documentElement.clientWidth).toBe(width);
  for (const editor of [first, second]) {
    await expect(within(editor).getAllByRole('heading', { level: 4 })).toHaveLength(3);
    await expect(editor.querySelectorAll('fieldset > legend')).toHaveLength(2);
    for (const label of editor.querySelectorAll<HTMLLabelElement>('label')) {
      await expect(label.htmlFor).not.toBe('');
      const control = document.getElementById(label.htmlFor)!;
      await expect(editor.contains(control)).toBe(true);
      await expect(control.closest('[data-slot="field"]')).toBe(label.closest('[data-slot="field"]'));
      await expect([...document.querySelectorAll('[id]')].filter((node) => node.id === label.htmlFor)).toHaveLength(1);
    }
    await expect(editor.querySelector('a[data-slot="list-row-link"], a input, a select, a button')).toBeNull();
    await expect(within(editor).getByRole('textbox', { name: m.correction_language() })).toHaveValue('fr');
    await expect(within(editor).getByRole('textbox', { name: m.correction_lower() })).toHaveValue('+1.74');
    await expect(within(editor).getByRole('textbox', { name: m.correction_upper() })).toHaveValue('+1.76');
    await expect(editor).toHaveTextContent(m.correction_preserved());
  }
  const addQualifier = within(first).getByRole('combobox', { name: m.correction_add_qualifier() });
  const label = [...first.querySelectorAll<HTMLLabelElement>('label')].find(
    (node) => node.htmlFor === addQualifier.id,
  )!;
  await userEvent.click(label);
  await expect(addQualifier).toHaveFocus();
  await userEvent.selectOptions(addQualifier, 'schema:position');
  await userEvent.tab();
  const add = within(addQualifier.closest('[data-slot="field"]')!.parentElement!).getByRole('button', {
    name: m.correction_add(),
  });
  await expect(add).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(within(first).getAllByRole('textbox', { name: m.correction_value() })).toHaveLength(4);
  await expect(within(second).getAllByRole('textbox', { name: m.correction_value() })).toHaveLength(3);
  await expect(within(second).getByRole('combobox', { name: m.correction_add_qualifier() })).toHaveValue('');

  // A citation addition belongs only to its own group and editor, retaining every supplied part.
  const part = within(second).getAllByRole('combobox', { name: m.correction_add_part() })[1]!;
  await userEvent.selectOptions(part, 'schema:url');
  await userEvent.click(
    within(part.closest('[data-slot="field"]')!.parentElement!).getByRole('button', { name: m.correction_add() }),
  );
  const addedUrl = within(second).getAllByRole('textbox', { name: m.correction_url() }).at(-1)!;
  await userEvent.type(addedUrl, 'https://example.org/second-editor/additional-source');
  await expect(addedUrl).toHaveFocus();
  await expect(within(first).getAllByRole('textbox', { name: m.correction_url() })).toHaveLength(2);
  await expect(within(second).getAllByRole('textbox', { name: m.correction_url() })).toHaveLength(3);
  for (const editor of [first, second])
    await expect(within(editor).getAllByRole('textbox', { name: m.correction_url() })[0]).toHaveValue(
      'https://www.wikidata.org/wiki/Q25338',
    );

  // Actual browser rectangles and full text runs, authored only. DOM construction is not this proof.
  for (const panel of [family, first, second])
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  for (const target of family.querySelectorAll<HTMLElement>('input, select, button[data-slot="button"]')) {
    const rect = target.getBoundingClientRect();
    const panel = target.closest('[data-family-editor], article')!.getBoundingClientRect();
    await expect(rect.height).toBeGreaterThanOrEqual(width === 390 ? 44 : 32);
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.left).toBeGreaterThanOrEqual(panel.left - 1);
    await expect(rect.right).toBeLessThanOrEqual(panel.right + 1);
  }
  for (const text of family.querySelectorAll<HTMLElement>(
    'label, legend, h1, h2, h3, h4, button[data-slot="button"]',
  )) {
    const bounds = text.getBoundingClientRect();
    const walker = document.createTreeWalker(text, 4);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) {
        await expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
        await expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
        await expect(line.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
      }
    }
  }
  await userEvent.tab();
  const focused = document.activeElement as HTMLElement;
  await expect(second.contains(focused)).toBe(true);
  const style = document.defaultView!.getComputedStyle(focused);
  await expect(
    style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0),
  ).toBe(true);
}

const familyEvidence = {
  docs: {
    description: {
      story:
        'UNRUN: actual standalone scalar editor plus two independent shared relation-field compositions using supplied native-format author/citation data. Full localized labels, h4 nesting, native label activation/Tab/Enter, complete citations and real phone/desktop/RTL geometry assertions are authored; native, browser, visual and original acceptance remain deferred. No relation-correction route or backend growth proof is claimed.',
    },
  },
};
export const FamilyPhone: Story = {
  render: () => <FamilyExample />,
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'de' },
  parameters: familyEvidence,
  play: ({ canvasElement }) => familyJourney(canvasElement, 390),
};
export const FamilyDesktop: Story = {
  render: () => <FamilyExample />,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  parameters: familyEvidence,
  play: ({ canvasElement }) => familyJourney(canvasElement, 1280),
};
export const FamilyRtl: Story = {
  render: () => <FamilyExample rtl />,
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'fr' },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => {
    await familyJourney(canvasElement, 390);
    await expect(canvasElement.querySelector('[data-statement-family]')).toHaveAttribute('dir', 'rtl');
  },
};

import { chooseCurrentSelectOption, chooseSelectValue } from './select-option';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { fromPlainText } from '@rezics/document';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AuthoredField } from '../features/catalogue/authored-field-view';
import { authoredFixture, type AuthoredScenario } from '../kernel/fake/authored-field';
import { RECORDED_SELECTED_SYNOPSIS_CITATION } from '../kernel/recorded/selected-synopsis';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function EditorExample({ scenario }: { scenario: AuthoredScenario | 'loading' }) {
  const locale = getLocale();
  const fixture = useMemo(
    () => authoredFixture(scenario === 'loading' ? 'ready' : scenario, locale),
    [scenario, locale],
  );
  const query = useQuery({
    queryKey: ['authored-story', scenario, locale],
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => (scenario === 'loading' ? new Promise<never>(() => {}) : fixture.transport.read()),
  });
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return (
    <AuthoredField
      key={`${scenario}:${locale}`}
      initial={query.data}
      locale={locale}
      transport={fixture.transport}
      confirm={fixture.confirm}
    />
  );
}
function Example({ scenario = 'ready' }: { scenario?: AuthoredScenario | 'loading' }) {
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <EditorExample scenario={scenario} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Catalogue/Authored text',
  id: 'pages-catalogue-authored-text',
  component: Example,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'An original, licensed replacement document uses the generated candidate API and existing review controls. Declared story samples are isolated from runtime. Proposed text is read through the actual candidate locator; public text is read independently. Locale, theme and viewport globals apply to every state. Native integration and Web/Root visual review remain pending.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function compose(canvasElement: HTMLElement, language = 'en', licence = 'CC-BY-4.0') {
  const canvas = within(canvasElement);
  const selected = await canvas.findByRole('region', { name: m.authored_selected() });
  await within(selected).findByText('An aviator meets a young traveller in the desert.');
  const editor = await canvas.findByRole('textbox', { name: m.authored_text() });
  await userEvent.click(editor);
  await userEvent.type(editor, 'A quiet story about friendship.');
  await userEvent.tab();
  await userEvent.type(canvas.getByRole('textbox', { name: m.authored_language() }), language);
  await userEvent.type(canvas.getByRole('textbox', { name: m.authored_licence() }), licence);
  await userEvent.type(
    canvas.getByRole('textbox', { name: m.authored_citation() }),
    'https://example.org/original-notes',
  );
  await userEvent.click(canvas.getByRole('checkbox', { name: m.authored_original() }));
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await compose(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.correction_submit() }));
  return canvas;
}
async function review(canvasElement: HTMLElement) {
  const canvas = await submit(canvasElement);
  await canvas.findByText(m.authored_submitted());
  await userEvent.click(canvas.getByRole('button', { name: m.correction_review() }));
  const candidate = await canvas.findByRole('region', { name: m.authored_candidate() });
  await expect(within(candidate).getByText('A quiet story about friendship.')).toBeVisible();
  await expect(
    within(canvas.getByRole('region', { name: m.authored_selected() })).queryByText('A quiet story about friendship.'),
  ).toBeNull();
  return canvas;
}
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await compose(canvasElement);
    await expect(canvas.getByRole('textbox', { name: m.authored_language() })).toHaveValue('en');
    await expect(canvas.getByRole('textbox', { name: m.authored_text() })).toHaveTextContent(
      'A quiet story about friendship.',
    );
    await expect(canvas.getByRole('button', { name: m.correction_submit() })).toBeEnabled();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.authored_empty());
  },
};
export const NoSelection: Story = { args: { scenario: 'no-selection' } };
export const BodyUnavailable: Story = {
  args: { scenario: 'body-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selected = await canvas.findByRole('region', { name: m.authored_selected() });
    await within(selected).findByText(m.authored_body_unavailable());
    await userEvent.click(within(selected).getByRole('button', { name: m.authored_reload_current_text() }));
    await within(selected).findByText(m.authored_body_unavailable());
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_denied());
    await within(await canvas.findByRole('region', { name: m.authored_selected() })).findByText(
      'An aviator meets a young traveller in the desert.',
    );
    await expect(canvas.queryByRole('textbox', { name: m.authored_text() })).toBeNull();
  },
};
export const InvalidLanguage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await compose(canvasElement, 'not_a_language');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_submit() }));
    await canvas.findByText(m.authored_invalid());
    await expect(canvas.getByRole('textbox', { name: m.authored_language() })).toHaveAttribute('aria-invalid', 'true');
  },
};
export const InvalidLicence: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await compose(canvasElement, 'en', 'Unknown-Licence');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_submit() }));
    await canvas.findByText(m.authored_invalid());
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_invalid());
    await expect(canvas.getByRole('textbox', { name: m.authored_language() })).toHaveValue('en');
  },
};
export const Conflict: Story = {
  args: { scenario: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_stale());
    await expect(canvas.getByRole('textbox', { name: m.authored_text() })).toHaveTextContent(
      'A quiet story about friendship.',
    );
    await expect(canvas.getByRole('button', { name: m.authored_review_draft() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.correction_submit() })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: m.authored_licence() })).toHaveValue('CC-BY-4.0');
    await expect(canvas.getByRole('textbox', { name: m.authored_citation() })).toHaveValue(
      'https://example.org/original-notes',
    );
    await expect(canvas.getByRole('textbox', { name: m.authored_language() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.authored_review_draft() }));
    await expect(canvas.getByRole('textbox', { name: m.authored_language() })).toHaveValue('en');
    await expect(canvas.getByRole('textbox', { name: m.authored_licence() })).toHaveValue('CC-BY-4.0');
    await expect(canvas.getByRole('textbox', { name: m.authored_citation() })).toHaveValue(
      'https://example.org/original-notes',
    );
    await expect(canvas.getByRole('textbox', { name: m.authored_text() })).toHaveTextContent(
      'A quiet story about friendship.',
    );
    await waitFor(() => expect(canvas.getByRole('button', { name: m.correction_submit() })).toBeEnabled());
    // Finish on the actual rejection so the conflict capture includes the retained, frozen draft.
    await userEvent.click(canvas.getByRole('button', { name: m.correction_submit() }));
    await canvas.findByText(m.correction_stale());
    await expect(canvas.getByRole('textbox', { name: m.authored_text() })).toHaveTextContent(
      'A quiet story about friendship.',
    );
    await expect(canvas.getByRole('button', { name: m.authored_review_draft() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.correction_submit() })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: m.authored_language() })).toBeDisabled();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'lost-response' },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: the existing default composition at 390px checks shared Select targets, wrapped labels, retained uncertain submission, exact-proposal retry, independent comparison and public readback after selection. Browser, native and visual verification remain deferred.',
      },
    },
  },
  play: async ({ canvasElement, step }) => {
    await step(
      'Existing default correction composition preserves submission and recovery with usable wrapped phone controls',
      async () => {
        const canvas = within(canvasElement);
        const selected = await canvas.findByRole('region', { name: m.authored_selected() });
        const article = canvas.getByRole('article');
        const bounds = article.getBoundingClientRect();
        await expect(bounds.width).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
        const contained = async (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          await expect(element).toBeVisible();
          await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
          await expect(rect.right).toBeLessThanOrEqual(bounds.right);
          await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
          await expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
        };
        const target = async (element: HTMLElement) => {
          await contained(element);
          await expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
          await expect(element.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        };
        const property = canvas.getByRole('combobox', { name: m.candidate_field() });
        const reload = within(selected).getByRole('button', { name: m.authored_reload_current_text() });
        for (const control of [
          property,
          reload,
          canvas.getByRole('textbox', { name: m.authored_language() }),
          canvas.getByRole('textbox', { name: m.authored_licence() }),
          canvas.getByRole('textbox', { name: m.authored_citation() }),
          canvas.getByRole('button', { name: m.correction_submit() }),
        ])
          await target(control);
        const original = canvas.getByRole('checkbox', { name: m.authored_original() });
        const labels = Array.from(article.querySelectorAll<HTMLLabelElement>('label[for]'));
        for (const control of [
          property,
          canvas.getByRole('textbox', { name: m.authored_language() }),
          canvas.getByRole('textbox', { name: m.authored_licence() }),
          canvas.getByRole('textbox', { name: m.authored_citation() }),
          original,
        ]) {
          const label = labels.find((label) => label.htmlFor === control.id);
          await expect(label).toBeDefined();
          await expect(article.ownerDocument.getElementById(label!.htmlFor)).toBe(control);
          await contained(label!);
        }
        const originalLabel = labels.find((label) => label.htmlFor === original.id)!;
        await target(originalLabel);
        if (getLocale() === 'en') {
          const text = canvasElement.ownerDocument.createRange();
          text.selectNodeContents(originalLabel);
          await expect(text.getClientRects().length).toBeGreaterThan(1);
        }
        await chooseCurrentSelectOption(property);
        await waitFor(() => expect(reload).toBeEnabled());
        await userEvent.click(reload);
        await waitFor(() => expect(reload).toBeEnabled());
        await within(selected).findByText('An aviator meets a young traveller in the desert.');

        await submit(canvasElement);
        await canvas.findByText(m.correction_unavailable());
        const retry = canvas.getByRole('button', { name: m.correction_retry() });
        await target(retry);
        await expect(property).toBeDisabled();
        await expect(reload).toBeDisabled();
        await expect(canvas.getByRole('textbox', { name: m.authored_text() })).toHaveTextContent(
          'A quiet story about friendship.',
        );
        for (const [name, value] of [
          [m.authored_language(), 'en'],
          [m.authored_licence(), 'CC-BY-4.0'],
          [m.authored_citation(), 'https://example.org/original-notes'],
        ] as const) {
          const field = canvas.getByRole('textbox', { name });
          await expect(field).toBeDisabled();
          await expect(field).toHaveValue(value);
        }
        await expect(canvas.getByRole('checkbox', { name: m.authored_original() })).toBeChecked();
        await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
        await canvas.findByText(m.authored_submitted());
        const comparisonAction = canvas.getByRole('button', { name: m.correction_review() });
        await target(comparisonAction);
        comparisonAction.focus();
        await userEvent.keyboard('{Enter}');
        const candidate = await canvas.findByRole('region', { name: m.authored_candidate() });
        await within(candidate).findByText('A quiet story about friendship.');
        await userEvent.click(reload);
        await waitFor(() => expect(reload).toBeEnabled());
        await within(selected).findByText('An aviator meets a young traveller in the desert.');
        await expect(within(selected).queryByText('A quiet story about friendship.')).toBeNull();
        await expect(within(candidate).getByText('A quiet story about friendship.')).toBeVisible();

        // Acceptance still requires a separate, explicit public selection and fresh public readback.
        await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
        const confirmations = await canvas.findAllByRole('button', { name: m.candidate_accept() });
        await userEvent.click(confirmations.at(-1)!);
        await canvas.findByText(m.candidate_accepted());
        await within(selected).findByText('An aviator meets a young traveller in the desert.');
        await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
        const choices = await canvas.findAllByRole('checkbox', { name: new RegExp(m.candidate_include()) });
        for (const choice of choices) await userEvent.click(choice);
        await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
        const adoption = await canvas.findAllByRole('button', { name: m.candidate_adopt() });
        await userEvent.click(adoption.at(-1)!);
        await within(selected).findByText('A quiet story about friendship.');
        await target(reload);
        await userEvent.click(reload);
        await within(selected).findByText('A quiet story about friendship.');
        await expect(within(selected).queryByText('An aviator meets a young traveller in the desert.')).toBeNull();
        await contained(article);
      },
    );
  },
};
export const Proposed: Story = {
  play: async ({ canvasElement }) => {
    await review(canvasElement);
  },
};
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await review(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_accept() }));
    const confirmations = await canvas.findAllByRole('button', { name: m.candidate_accept() });
    await userEvent.click(confirmations.at(-1)!);
    await canvas.findByText(m.candidate_accepted());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    // Explicitly replace the public selection with the reviewed candidate through the existing selection controls.
    const choices = await canvas.findAllByRole('checkbox', { name: new RegExp(m.candidate_include()) });
    for (const choice of choices) await userEvent.click(choice);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_adopt() }));
    const adoption = await canvas.findAllByRole('button', { name: m.candidate_adopt() });
    await userEvent.click(adoption.at(-1)!);
    const selected = await canvas.findByRole('region', { name: m.authored_selected() });
    await within(selected).findByText('A quiet story about friendship.');
    await userEvent.click(within(selected).getByRole('button', { name: m.authored_reload_current_text() }));
    await within(selected).findByText('A quiet story about friendship.');
    await expect(within(selected).queryByText('An aviator meets a young traveller in the desert.')).toBeNull();
    const comparison = canvas.getByRole('region', { name: m.candidate_title() });
    // Current, proposed and selection values reuse the exact authorized native document.
    await expect(
      (await within(comparison).findAllByText('A quiet story about friendship.')).length,
    ).toBeGreaterThanOrEqual(3);
  },
};

const longName = `The traveller’s original account — ${'A name without a short substitute '.repeat(10)}終章`;
const longBody = `The complete supplied text begins here. ${'Friendship, responsibility and a journey across distant worlds. '.repeat(30)}The complete supplied text ends here.`;
const longAttribution = `Supplied original authors and contributors — ${'A complete credit without truncation '.repeat(12)}`;
const longCitation = `https://example.org/notes/${'unbroken-source-name'.repeat(24)}`;

// Constructed supplied-content fixtures, not native disclosure or visual evidence.
function SuppliedEditor({ slot, long }: { slot: string; long: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const fixture = authoredFixture('ready', locale);
    if (long) {
      fixture.publicRead.subject.labels = { [locale]: longName };
      fixture.old.references = Array.from({ length: 3 }, (_, index): (typeof fixture.old.references)[number] => ({
        hash: `supplied-citation-${index}`,
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: `${longCitation}/${index}` },
          },
        ],
      }));
      for (const [id, document] of fixture.documents) {
        const { subjectId, candidateId, revision, language, digest } = document;
        fixture.documents.set(id, {
          id,
          subjectId,
          candidateId,
          revision,
          language,
          digest,
          availability: 'available',
          body: fromPlainText(longBody),
          source: {
            source: 'fixture',
            external_id: 'supplied-notes',
            record_revision: '1',
            digest,
            converter_revision: 'fixture',
            field_group: 'summary',
            references: [],
          },
          rights: { license: 'CC-BY-4.0', obligations: ['attribution'], attribution: longAttribution },
        });
      }
    }
    return fixture;
  }, [locale, long]);
  const query = useQuery({
    queryKey: ['authored-supplied', slot, locale, long],
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => fixture.transport.read(),
  });
  if (!query.data) return <p role="status">{m.candidate_loading()}</p>;
  return <AuthoredField initial={query.data} locale={locale} transport={fixture.transport} confirm={fixture.confirm} />;
}
function IndependentExamples({ long = false }: { long?: boolean }) {
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <div className="min-w-0 space-y-8">
          <SuppliedEditor slot="first" long={long} />
          <SuppliedEditor slot="second" long={long} />
        </div>
      </AppShell>
    </PatternStory>
  );
}
const unrun = {
  docs: {
    description: {
      story:
        'UNRUN: actual AuthoredField composition with supplied fixtures. Native, browser, accessibility, geometry and visual acceptance remain deferred.',
    },
  },
};
async function independentForms(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getAllByRole('form', { name: m.authored_replacement() })).toHaveLength(2));
  const articles = canvas.getAllByRole('article');
  const first = within(articles[0]!);
  const second = within(articles[1]!);
  const firstLanguage = first.getByRole('textbox', { name: m.authored_language() });
  const secondLanguage = second.getByRole('textbox', { name: m.authored_language() });
  await expect(firstLanguage.id).not.toBe(secondLanguage.id);
  await userEvent.type(firstLanguage, 'en');
  await expect(secondLanguage).toHaveValue('');
  await userEvent.click(first.getByRole('button', { name: m.correction_submit() }));
  await first.findByText(m.authored_invalid());
  await expect(second.queryByText(m.authored_invalid())).toBeNull();
  const errors = first.getByRole('alert');
  for (const link of within(errors).getAllByRole('link')) {
    const target = canvasElement.ownerDocument.getElementById(
      decodeURIComponent((link as HTMLAnchorElement).hash.slice(1)),
    );
    await expect(target).not.toBeNull();
    await expect(articles[0]!.contains(target)).toBe(true);
    await expect(articles[1]!.contains(target)).toBe(false);
  }
  await expect(first.getByRole('textbox', { name: m.authored_language() }).id).toBe(firstLanguage.id);
  return { articles, first, second };
}
export const IndependentForms: Story = {
  render: () => <IndependentExamples />,
  parameters: unrun,
  play: async ({ canvasElement }) => {
    await independentForms(canvasElement);
  },
};
export const LongSuppliedContent: Story = {
  render: () => <IndependentExamples long />,
  parameters: unrun,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole('form', { name: m.authored_replacement() })).toHaveLength(2));
    for (const article of canvas.getAllByRole('article')) {
      const local = within(article);
      await expect(local.getByRole('link', { name: longName })).toHaveTextContent(longName);
      const selected = local.getByRole('region', { name: m.authored_selected() });
      await expect(within(selected).getByText(longBody)).toBeVisible();
      await expect(
        within(selected)
          .getByText(/CC-BY-4.0/)
          .closest('details'),
      ).toBeNull();
      await expect(within(selected).getByText(longAttribution)).toBeVisible();
      await expect(within(selected).getByText(longAttribution).closest('details')).toBeNull();
      const summary = selected.querySelector('summary')!;
      summary.focus();
      await userEvent.keyboard('{Enter}');
      for (let index = 0; index < 3; index++)
        await expect(within(selected).getByRole('link', { name: `${longCitation}/${index}` })).toBeVisible();
      await expect(local.getByRole('textbox', { name: m.authored_text() })).toHaveTextContent('');
    }
  },
};
export const Associations: Story = {
  render: () => <IndependentExamples long />,
  parameters: unrun,
  play: async ({ canvasElement }) => {
    const { articles } = await independentForms(canvasElement);
    for (const article of articles) {
      const local = within(article);
      const bounds = article.getBoundingClientRect();
      await expect(bounds.width).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
      const selected = local.getByRole('region', { name: m.authored_selected() });
      await userEvent.click(selected.querySelector('summary')!);
      for (const control of [
        local.getByRole('combobox', { name: m.candidate_field() }),
        ...local.getAllByRole('textbox').filter((element) => element.tagName === 'INPUT'),
        local.getByRole('checkbox', { name: m.authored_original() }),
        ...local.getAllByRole('button', { name: m.correction_submit() }),
        ...local.getAllByRole('link'),
        selected.querySelector('summary')!,
      ]) {
        const rect = control.getBoundingClientRect();
        await expect(rect.height).toBeGreaterThanOrEqual(44);
        await expect(rect.width).toBeGreaterThanOrEqual(44);
        await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
        await expect(rect.right).toBeLessThanOrEqual(bounds.right);
        await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
      }
      await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
    }
  },
};
export const KeyboardAssociations: Story = {
  render: () => <IndependentExamples />,
  parameters: unrun,
  play: async ({ canvasElement }) => {
    const { articles, first, second } = await independentForms(canvasElement);
    const language = second.getByRole('textbox', { name: m.authored_language() });
    const languageLabel = Array.from(articles[1]!.querySelectorAll<HTMLLabelElement>('label[for]')).find(
      (label) => label.htmlFor === language.id,
    )!;
    await userEvent.click(languageLabel);
    await expect(language).toHaveFocus();
    await userEvent.type(language, 'ja');
    await userEvent.tab();
    await expect(second.getByRole('textbox', { name: m.authored_licence() })).toHaveFocus();
    await userEvent.type(canvasElement.ownerDocument.activeElement!, 'CC0-1.0');
    await userEvent.tab();
    await expect(second.getByRole('textbox', { name: m.authored_citation() })).toHaveFocus();
    await userEvent.tab();
    const original = second.getByRole('checkbox', { name: m.authored_original() });
    await expect(original).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(original).toBeChecked();
    await expect(first.getByRole('checkbox', { name: m.authored_original() })).not.toBeChecked();
    await expect(first.getByRole('textbox', { name: m.authored_language() })).toHaveValue('en');
    const errorLink = within(first.getByRole('alert')).getByRole('link', { name: m.authored_licence() });
    errorLink.focus();
    await userEvent.keyboard('{Enter}');
    await expect(first.getByRole('textbox', { name: m.authored_licence() })).toHaveFocus();
  },
};

let selectedAbaNavigate: ((visit: 'a' | 'b') => Promise<void>) | undefined;
let selectedAbaRelease: (() => void) | undefined;
let selectedAbaHeld = false;

function SelectedComparisonExample({ retryAba = false }: { retryAba?: boolean }) {
  const locale = getLocale();
  const router = useRouter();
  const releaseRetry = useRef<(() => void) | undefined>(undefined);
  const fixture = useMemo(() => {
    let first = true;
    return authoredFixture('ready', locale, {
      selected: true,
      ...(retryAba
        ? {
            holdRead: async () => {
              if (first) {
                first = false;
                return;
              }
              await new Promise<void>((resolve) => {
                selectedAbaHeld = true;
                releaseRetry.current = () => {
                  selectedAbaHeld = false;
                  resolve();
                };
              });
            },
          }
        : {}),
    });
  }, [locale, retryAba]);
  const query = useQuery({
    queryKey: ['authored-selected-story', locale, retryAba],
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => fixture.transport.read('schema:abstract'),
  });
  selectedAbaNavigate = retryAba
    ? async (visit) => {
        await router.navigate({ to: `/?retryVisit=${visit}` } as never);
      }
    : undefined;
  selectedAbaRelease = retryAba ? () => releaseRetry.current?.() : undefined;
  if (!query.data)
    return (
      <p role="status" className="p-6">
        {m.candidate_loading()}
      </p>
    );
  return (
    <AuthoredField
      key={`${locale}:${retryAba}`}
      initial={query.data}
      locale={locale}
      inspection={fixture.via}
      transport={fixture.transport}
      confirm={fixture.confirm}
    />
  );
}

function SelectedComparisonStory({ retryAba = false }: { retryAba?: boolean }) {
  return (
    <PatternStory path="/?retryVisit=a" visitor="Signed In">
      <AppShell>
        <SelectedComparisonExample retryAba={retryAba} />
      </AppShell>
    </PatternStory>
  );
}

async function selectedComparisonPlay(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const selected = await canvas.findByRole('region', { name: m.authored_selected() });
  await expect(
    within(selected).getByText(
      'A pilot stranded in the Sahara meets a small prince who has left his asteroid, and learns from him what matters.',
    ),
  ).toBeVisible();
  const citations = selected.querySelector('summary');
  expect(citations).toBeTruthy();
  await userEvent.click(citations!);
  expect(await canvas.findByRole('link', { name: RECORDED_SELECTED_SYNOPSIS_CITATION })).toHaveAttribute(
    'href',
    RECORDED_SELECTED_SYNOPSIS_CITATION,
  );
}

async function selectedComparisonAbaPlay(canvasElement: HTMLElement) {
  await selectedComparisonPlay(canvasElement);
  const canvas = within(canvasElement);
  const reload = canvas.getByRole('button', { name: m.authored_reload_current_text() });
  reload.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(selectedAbaHeld).toBe(true));
  await selectedAbaNavigate?.('b');
  await selectedAbaNavigate?.('a');
  selectedAbaRelease?.();
  expect(await canvas.findByRole('link', { name: RECORDED_SELECTED_SYNOPSIS_CITATION })).toBeTruthy();
  await waitFor(() => {
    const heading = canvas.getByRole('heading', { name: m.authored_title() });
    expect(canvasElement.ownerDocument.activeElement).not.toBe(heading);
  });
}

export const SelectedSynopsisComparison: Story = {
  render: () => <SelectedComparisonStory />,
  play: async ({ canvasElement }) => selectedComparisonPlay(canvasElement),
};

export const SelectedSynopsisComparisonABA: Story = {
  render: () => <SelectedComparisonStory retryAba />,
  play: async ({ canvasElement }) => selectedComparisonAbaPlay(canvasElement),
};

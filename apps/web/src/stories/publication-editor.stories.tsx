import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { PublicationEditor } from '../features/catalogue/publication-editor-form';
import { publicationCreatedId, publicationFixture, type PublicationScenario } from '../kernel/fake/publication-editor';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function PublicationStory({
  scenario = 'ready',
  workType = 'schema:Book',
  signedOut = false,
}: {
  scenario?: PublicationScenario;
  workType?: string;
  signedOut?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => publicationFixture(scenario, locale, workType), [scenario, locale, workType]);
  return (
    <PatternStory
      path={`/catalogue/publication?work=${fixture.work.subject.id}`}
      visitor={signedOut ? 'Signed Out' : 'Signed In'}
    >
      <AppShell>
        <PublicationEditor
          key={`${scenario}:${locale}:${workType}`}
          work={fixture.work.subject.id}
          locale={locale}
          session={signedOut ? 'signed-out' : 'signed-in'}
          transport={fixture.transport}
          search={async () => [
            {
              id: '00000000-0000-4000-8000-00000000e003',
              title: 'Example Press',
              types: ['schema:Organization'],
              typeLabel: 'Publisher',
              cover: null,
            },
          ]}
          onNavigate={() => {
            /* Keep the exact confirmed reader link available for review. */
          }}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Publication editor',
  component: PublicationStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Ordinary publication creation with an existing work, emitted profiles and native-shaped request examples. Native acceptance and Web/Root visual review remain pending.',
      },
    },
  },
} satisfies Meta<typeof PublicationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A distinct edition');
  const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.click(canvas.getByRole('checkbox', { name: m.publication_independent() }));
  await userEvent.type(
    within(canvasElement.querySelector('[id$="-work-link"]') as HTMLElement).getByRole('textbox', {
      name: m.correction_url(),
    }),
    'https://publisher.example/edition',
  );
  const field = canvas.getByRole('combobox', { name: m.publication_field() });
  await userEvent.selectOptions(field, 'schema:isbn');
  await userEvent.click(within(field.closest('fieldset')!).getByRole('button', { name: m.correction_add() }));
  await userEvent.type(canvas.getByRole('textbox', { name: m.correction_value() }), '978-0-140-44430-8');
  return canvas;
}
async function submit(canvasElement: HTMLElement) {
  const canvas = await fill(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.publication_review() }));
  await canvas.findByRole('heading', { name: m.publication_review() });
  await userEvent.click(canvas.getByRole('button', { name: m.publication_submit() }));
  return canvas;
}
export const Ready: Story = {};
export const Loading: Story = { args: { scenario: 'loading' } };
export const NoReleasedProfile: Story = { args: { scenario: 'empty' } };
export const SignedOut: Story = { args: { signedOut: true } };
export const WorkUnavailable: Story = { args: { scenario: 'concealed' } };
export const SuccessfulCreation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('link', { name: m.catalogue_create_open() })).toHaveAttribute(
      'href',
      `/${getLocale()}/subjects/${publicationCreatedId}/a-distinct-edition`,
    );
    expect(canvas.queryByRole('button', { name: m.publication_submit() })).toBeNull();
  },
};
export const GrainRequired: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'A file in French');
    await userEvent.click(canvas.getByRole('button', { name: m.publication_review() }));
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
    expect(canvas.getByRole('checkbox', { name: m.publication_independent() })).toHaveAttribute('aria-invalid', 'true');
  },
};
export const AnthologyWorkLink: Story = {
  args: { workType: 'schema:Movie' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.relation_property() }), 'bf:hasPart');
    expect(canvas.getByRole('combobox', { name: m.relation_property() })).toHaveValue('bf:hasPart');
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_denied());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('A distinct edition');
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
    expect(canvas.getByRole('textbox', { name: m.correction_value() })).toHaveValue('978-0-140-44430-8');
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_conflict());
    expect(canvas.getByRole('button', { name: m.publication_review() })).toBeDisabled();
  },
};
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.catalogue_create_retry() }));
    expect(await canvas.findByRole('textbox', { name: m.catalogue_create_label() })).toBeVisible();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: the default creation composition at 390px checks native targets, field/action reflow, the confirmation label hit area, retained uncertain drafts and retry to the exact created reader. Browser, native and visual verification remain deferred.',
      },
    },
  },
  play: async ({ canvasElement, step }) => {
    await step(
      'Existing default composition retains command and recovery behavior with usable wrapped phone controls',
      async () => {
        const canvas = within(canvasElement);
        await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
        const article = canvas.getByRole('article');
        const bounds = article.getBoundingClientRect();
        await expect(bounds.width).toBeLessThanOrEqual(390);
        const contained = async (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          await expect(element).toBeVisible();
          await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
          await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
        };
        const readable = async (element: HTMLElement) => {
          await contained(element);
          await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
          await expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
          const text = canvasElement.ownerDocument.createRange();
          text.selectNodeContents(element);
          const rect = element.getBoundingClientRect();
          for (const line of text.getClientRects()) {
            await expect(line.left).toBeGreaterThanOrEqual(rect.left - 1);
            await expect(line.right).toBeLessThanOrEqual(rect.right + 1);
            await expect(line.bottom).toBeLessThanOrEqual(rect.bottom + 1);
          }
          return text.getClientRects().length;
        };
        const target = async (element: HTMLElement) => {
          await contained(element);
          await expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
          await expect(element.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        };
        const field = canvas.getByRole('combobox', { name: m.publication_field() });
        const add = within(field.closest('fieldset')!).getByRole('button', { name: m.correction_add() });
        const create = canvas.getByRole('button', { name: m.publication_review() });
        const back = canvas.getByRole('link', { name: m.publication_back() });
        const discovery = canvas.getByRole('link', { name: m.publication_search() });
        const workUrl = within(canvasElement.querySelector('[id$="-work-link"]') as HTMLElement).getByRole('textbox', {
          name: m.correction_url(),
        });
        for (const control of [
          canvas.getByRole('textbox', { name: m.catalogue_create_label() }),
          canvas.getByRole('textbox', { name: m.catalogue_create_language() }),
          canvas.getByRole('combobox', { name: m.relation_property() }),
          field,
          add,
          workUrl,
          create,
          back,
          discovery,
        ])
          await target(control);
        // The selector keeps its own phone row instead of shrinking beside Add.
        await expect(add.getBoundingClientRect().top).toBeGreaterThanOrEqual(field.getBoundingClientRect().bottom);
        for (const action of [add, create, back, discovery]) await readable(action);
        // Constrain the actual localized action to exercise wrapping without substituting its copy or component.
        const previousMaxWidth = discovery.style.maxWidth;
        try {
          discovery.style.maxWidth = '7rem';
          await target(discovery);
          const lines = await readable(discovery);
          if (getLocale() === 'en') await expect(lines).toBeGreaterThan(1);
        } finally {
          discovery.style.maxWidth = previousMaxWidth;
        }
        const independent = canvas.getByRole('checkbox', { name: m.publication_independent() });
        const confirmation = canvas.getByText(m.publication_independent(), { selector: 'label', exact: true });
        await target(confirmation);
        const confirmationLines = await readable(confirmation);
        if (getLocale() === 'en') await expect(confirmationLines).toBeGreaterThan(1);
        await userEvent.click(confirmation);
        await expect(independent).toBeChecked();
        await userEvent.click(confirmation);
        await expect(independent).not.toBeChecked();
        await userEvent.selectOptions(field, 'schema:isbn');
        await userEvent.click(add);
        const remove = canvas.getByRole('button', { name: m.relation_remove() });
        await target(remove);
        await readable(remove);
        await target(canvas.getByRole('textbox', { name: m.correction_value() }));
        await target(canvas.getByRole('combobox', { name: m.correction_value_state() }));
        await userEvent.click(remove);
        await expect(canvas.queryByRole('textbox', { name: m.correction_value() })).toBeNull();

        await submit(canvasElement);
        expect(await canvas.findByRole('alert')).toHaveTextContent(m.catalogue_create_uncertain());
        expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
        for (const [name, value] of [
          [m.catalogue_create_label(), 'A distinct edition'],
          [m.catalogue_create_language(), 'en'],
          [m.correction_value(), '978-0-140-44430-8'],
        ] as const) {
          const control = canvas.getByRole('textbox', { name });
          await expect(control).toBeDisabled();
          await expect(control).toHaveValue(value);
        }
        const sealedIndependent = canvas.getByRole('checkbox', { name: m.publication_independent() });
        await expect(sealedIndependent).toBeChecked();
        await expect(sealedIndependent).toBeDisabled();
        await expect(canvas.getByRole('combobox', { name: m.publication_field() })).toBeDisabled();
        const sealedUrl = within(canvasElement.querySelector('[id$="-work-link"]') as HTMLElement).getByRole(
          'textbox',
          { name: m.correction_url() },
        );
        await expect(sealedUrl).toBeDisabled();
        await expect(sealedUrl).toHaveValue('https://publisher.example/edition');
        const retry = canvas.getByRole('button', { name: m.catalogue_create_retry() });
        await target(retry);
        await readable(retry);
        await userEvent.click(retry);
        const open = await canvas.findByRole('link', { name: m.catalogue_create_open() });
        expect(open).toHaveAttribute('href', `/${getLocale()}/subjects/${publicationCreatedId}/a-distinct-edition`);
        await target(open);
        await readable(open);
        await expect(canvas.queryByRole('button', { name: m.publication_submit() })).toBeNull();
        await expect(canvas.queryByRole('button', { name: m.catalogue_create_retry() })).toBeNull();
      },
    );
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByRole('button', { name: m.catalogue_create_saving() })).toBeDisabled();
  },
};
export const CreatedReaderUnavailable: Story = {
  args: { scenario: 'reader-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_reader_unavailable())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};
export const CreatedReaderConcealed: Story = {
  args: { scenario: 'reader-concealed' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    expect(await canvas.findByText(m.catalogue_create_concealed())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
  },
};

// Constructed supplied metadata for presentation coverage; these are not new native profiles or recordings.
function PublicationFamilyStory({ longNames = false, rtl = false }: { longNames?: boolean; rtl?: boolean }) {
  const locale = getLocale();
  const fixtures = useMemo(
    () =>
      Array.from({ length: 2 }, (_, index) => {
        const fixture = publicationFixture(index === 0 ? 'invalid' : 'ready', locale);
        if (longNames) {
          fixture.work.subject.labels[locale] =
            'The collected journeys through the extraordinarily long unbroken archive ' + '星の図書館'.repeat(18);
          fixture.release.types['bf:Instance']!.labels[locale] =
            'An independently identified illustrated publication with a complete supplied profile ' + '版'.repeat(45);
          fixture.release.properties['schema:isbn']!.labels[locale] =
            'The complete international standard book number for this particular publication ' + '識別'.repeat(24);
          fixture.release.properties['schema:url']!.labels[locale] =
            'The publisher’s complete citation and supporting source for this independent publication ' +
            '出典'.repeat(24);
        }
        return fixture;
      }),
    [locale, longNames],
  );
  return (
    <PatternStory path={`/catalogue/publication?work=${fixtures[0]!.work.subject.id}`} visitor="Signed In">
      <AppShell>
        <div dir={rtl ? 'rtl' : undefined} className="grid min-w-0 gap-8 lg:grid-cols-2">
          {fixtures.map((fixture, index) => (
            <PublicationEditor
              key={index}
              work={fixture.work.subject.id}
              locale={locale}
              session="signed-in"
              transport={fixture.transport}
              search={async () => []}
              onNavigate={() => {
                /* Review only the reader returned by this instance's actual fixture transport. */
              }}
            />
          ))}
        </div>
      </AppShell>
    </PatternStory>
  );
}

async function independentFamily(canvasElement: HTMLElement, longNames = false) {
  const canvas = within(canvasElement);
  const articles = canvas.getAllByRole('article');
  const first = articles[0]!;
  const second = articles[1]!;
  const names = [
    await within(first).findByRole('textbox', { name: m.catalogue_create_label() }),
    await within(second).findByRole('textbox', { name: m.catalogue_create_label() }),
  ];
  const local = within(first);
  const other = within(second);
  const ids = [...canvasElement.querySelectorAll('[id]')].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const article of [first, second]) {
    for (const label of article.querySelectorAll<HTMLLabelElement>('label[for]')) {
      expect(article.contains(canvasElement.ownerDocument.getElementById(label.htmlFor))).toBe(true);
    }
  }
  await userEvent.type(names[1]!, 'Another independent draft');
  await userEvent.click(local.getByRole('button', { name: m.publication_review() }));
  expect(await local.findByRole('alert')).toHaveTextContent(m.catalogue_create_invalid());
  expect(other.queryByRole('alert')).toBeNull();
  expect(names[1]).toHaveValue('Another independent draft');
  // Use the original native-shaped creation flow; only this first editor is invalid at the transport boundary.
  await fill(first);
  await userEvent.click(local.getByRole('button', { name: m.publication_review() }));
  await local.findByRole('heading', { name: m.publication_review() });
  await userEvent.click(local.getByRole('button', { name: m.publication_submit() }));
  const corrections = await local.findAllByRole('alert');
  expect(corrections.some((alert) => alert.textContent?.includes(m.catalogue_create_invalid()))).toBe(true);
  for (const link of first.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const target = canvasElement.ownerDocument.getElementById(decodeURIComponent(link.hash.slice(1)))!;
    expect(first.contains(target)).toBe(true);
    expect(second.contains(target)).toBe(false);
    expect(target.tabIndex).toBeGreaterThanOrEqual(-1);
    await userEvent.click(link);
    expect(target).toHaveFocus();
  }
  expect(other.queryByRole('textbox', { name: m.correction_value() })).toBeNull();
  expect(names[1]).toHaveValue('Another independent draft');
  if (longNames) {
    for (const article of [first, second]) {
      const bounds = article.getBoundingClientRect();
      expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
      for (const heading of within(article).getAllByRole('heading')) {
        expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth + 1);
        const range = canvasElement.ownerDocument.createRange();
        range.selectNodeContents(heading);
        for (const line of range.getClientRects()) {
          expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
          expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
        }
      }
    }
  }
}

const familyEvidence = {
  docs: {
    description: {
      story:
        'UNRUN: two actual independent editors sharing the same supplied work, with local labels, validation, fact drafts and keyboard fragment targets. Constructed fixture metadata supports phone/desktop/RTL wrapping review; it supplies no native, SSR or visual proof.',
    },
  },
};
export const IndependentEditorsPhone: Story = {
  render: () => <PublicationFamilyStory />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => independentFamily(canvasElement),
};
export const IndependentEditorsDesktop: Story = {
  render: () => <PublicationFamilyStory />,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => independentFamily(canvasElement),
};
export const IndependentEditorsRtl: Story = {
  render: () => <PublicationFamilyStory rtl />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => independentFamily(canvasElement),
};
export const LongSuppliedNamesPhone: Story = {
  render: () => <PublicationFamilyStory longNames />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => independentFamily(canvasElement, true),
};
export const LongSuppliedNamesDesktop: Story = {
  render: () => <PublicationFamilyStory longNames />,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => independentFamily(canvasElement, true),
};
export const LongSuppliedNamesRtl: Story = {
  render: () => <PublicationFamilyStory longNames rtl />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: familyEvidence,
  play: async ({ canvasElement }) => independentFamily(canvasElement, true),
};

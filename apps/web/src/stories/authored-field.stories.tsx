import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { AuthoredField } from '../features/catalogue/authored-field-view';
import { authoredFixture, type AuthoredScenario } from '../kernel/fake/authored-field';
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
  title: 'Pages/Catalogue/Authored text',
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
export const BodyUnavailable: Story = { args: { scenario: 'body-unavailable' } };
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
    await expect(canvas.getByRole('button', { name: m.correction_submit() })).toBeEnabled();
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
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await canvas.findByText(m.authored_submitted());
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
    await userEvent.click(within(selected).getByRole('button', { name: m.correction_reload() }));
    await within(selected).findByText('A quiet story about friendship.');
    await expect(within(selected).queryByText('An aviator meets a young traveller in the desert.')).toBeNull();
    const comparison = canvas.getByRole('region', { name: m.candidate_title() });
    // Current, proposed and selection values reuse the exact authorized native document.
    await expect(
      (await within(comparison).findAllByText('A quiet story about friendship.')).length,
    ).toBeGreaterThanOrEqual(3);
  },
};

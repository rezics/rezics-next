import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { StatementEditor, EditorFailure } from '../features/catalogue/statement-editor-view';
import { readStatementEditor } from '../features/catalogue/statement-editor';
import { statementFixture, type StatementScenario } from '../kernel/fake/catalogue-statements';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function EditorExample({ scenario }: { scenario: StatementScenario | 'loading' | 'empty' }) {
  const locale = getLocale();
  const fixture = useMemo(
    () => statementFixture(scenario === 'loading' || scenario === 'empty' ? 'ready' : scenario, locale),
    [scenario, locale],
  );
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
function Example({ scenario = 'ready' }: { scenario?: StatementScenario | 'loading' | 'empty' }) {
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <EditorExample scenario={scenario} />
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
  args: { scenario: 'lost-response' },
  play: async ({ canvasElement }) => {
    const canvas = await submit(canvasElement);
    await canvas.findByText(m.correction_unavailable());
    await expect(canvas.getByRole('textbox', { name: m.correction_year() })).toHaveValue('1946');
    await userEvent.click(canvas.getByRole('button', { name: m.correction_retry() }));
    await canvas.findByText(m.correction_proposed());
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

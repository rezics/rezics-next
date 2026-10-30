import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { SubjectChanges } from '../features/catalogue/subject-changes-page';
import { catalogueChangesFixture, type ChangesScenario } from '../kernel/fake/catalogue-changes';
import { PatternStory } from './page';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { pageText } from '../features/pages/shared';
import { sourceDefinitions } from '../kernel/fake/catalogue-sources';

/** Preserve the existing presentation outcomes and plays. The terms sample is future consumer copy;
 * the bound native read serves record/candidate/decision/adoption only, never terms.
 */
function ChangesStory({
  scenario = 'ready',
  limited = false,
  detailLoading = false,
}: {
  scenario?: ChangesScenario;
  limited?: boolean;
  detailLoading?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(
    () =>
      catalogueChangesFixture(scenario, locale, async (_client, input) =>
        detailLoading
          ? new Promise(() => {})
          : {
              kind: 'ready',
              detail: {
                id: input.id,
                revision: input.revision,
                ...(input.revision !== 2 && !limited
                  ? { propertyLabel: pageText(sourceDefinitions.properties['schema:datePublished']?.labels, locale) }
                  : {}),
                summary: limited
                  ? { kind: 'limited' }
                  : input.revision === 2
                    ? { kind: 'terms', fields: ['label', 'description'], languages: ['fr', 'en'] }
                    : {
                        kind: 'candidate',
                        candidate: '00000000-0000-8000-8000-000000000005',
                        property: 'schema:datePublished',
                      },
              },
            },
      ),
    [scenario, locale, limited, detailLoading],
  );
  const transport = useMemo(
    () => ({
      ...fixture.transport,
      list: async (...args: Parameters<typeof fixture.transport.list>) => {
        const result = await fixture.transport.list(...args);
        if (result.kind !== 'ready') fixture.recover();
        return result;
      },
      detail: async (...args: Parameters<typeof fixture.transport.detail>) => {
        const result = await fixture.transport.detail(...args);
        fixture.recover();
        return result;
      },
    }),
    [fixture],
  );
  return (
    <PatternStory path="/" visitor="Signed Out">
      <AppShell>
        <SubjectChanges
          key={`${locale}:${scenario}:${limited}:${detailLoading}`}
          locale={locale}
          transport={transport}
          currentHref={`/${locale}/subjects/${fixture.id}`}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Changes',
  component: ChangesStory,
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <ChangesStory key={`${getLocale()}:${args.scenario}:${args.limited}:${args.detailLoading}`} {...args} />
  ),
} satisfies Meta<typeof ChangesStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const select = async (canvasElement: HTMLElement, revision: number) => {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole('button', { name: new RegExp(m.changes_revision({ revision: String(revision) })) }),
  );
  return canvas;
};
export const Revisions: Story = {};
export const ContinueAndExplain: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.changes_more() }));
    await waitFor(() => expect(canvas.getByRole('button', { name: m.changes_more() })).toBeEnabled());
    await userEvent.click(await canvas.findByRole('button', { name: m.changes_more() }));
    await select(canvasElement, 2);
    expect(await canvas.findByText(m.changes_terms())).toBeTruthy();
    expect(canvas.getByRole('link', { name: m.changes_current() }).getAttribute('href')).toContain('/subjects/');
  },
};
export const Proposal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    expect(await canvas.findByText(m.changes_proposal_detail())).toBeTruthy();
  },
};
export const LimitedSafeDetail: Story = {
  args: { limited: true },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    expect(await canvas.findByText(m.changes_limited())).toBeTruthy();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const Invalid: Story = { args: { scenario: 'invalid' } };
export const Conflict: Story = { args: { scenario: 'conflict' } };
export const Concealed: Story = { args: { scenario: 'missing' } };
export const UnavailableRetry: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.changes_retry() }));
    expect(await canvas.findByRole('heading', { name: m.changes_revisions() })).toBeTruthy();
  },
};
export const DetailRetry: Story = {
  args: { scenario: 'detail-retry' },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    await userEvent.click(await canvas.findByRole('button', { name: m.changes_retry_detail() }));
    expect(await canvas.findByText(m.changes_proposal_detail())).toBeTruthy();
  },
};

export const DetailLoading: Story = {
  args: { detailLoading: true },
  play: async ({ canvasElement }) => {
    const canvas = await select(canvasElement, 5);
    expect(await canvas.findByText(m.changes_detail_loading())).toBeTruthy();
  },
};

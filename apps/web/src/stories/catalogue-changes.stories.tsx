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
import { languageName } from '../subject/language';

/** Isolated presentation samples use the delivered terms field/language structure, without native proof. */
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
                    ? {
                        kind: 'terms',
                        fields: [
                          { field: 'labels', languages: ['fr'] },
                          { field: 'descriptions', languages: ['en'] },
                        ],
                      }
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
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'UNRUN: actual Changes continuation, revision selection and current-reading link target/text geometry at phone390. Browser, visual and native verification are deferred. The same story supports desktop1280 through the viewport global.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const revisions = within(await canvas.findByRole('region', { name: m.changes_revisions() }));
    const document = canvasElement.ownerDocument;
    const page = canvas.getByRole('article');
    const minimum = document.defaultView!.matchMedia('(max-width: 767px), (pointer: coarse)').matches ? 44 : 32;
    const contained = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      const pageBounds = page.getBoundingClientRect();
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      expect(bounds.left).toBeGreaterThanOrEqual(Math.max(0, pageBounds.left) - 1);
      expect(bounds.right).toBeLessThanOrEqual(Math.min(document.documentElement.clientWidth, pageBounds.right) + 1);
    };
    const targets = () => {
      contained(page);
      for (const target of [
        ...revisions.getAllByRole('button'),
        canvas.getByRole('link', { name: m.changes_current() }),
      ]) {
        contained(target);
        const bounds = target.getBoundingClientRect();
        expect(bounds.height).toBeGreaterThanOrEqual(minimum);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        const text = document.createTreeWalker(target, 4 /* SHOW_TEXT */);
        while (text.nextNode()) {
          if (!text.currentNode.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text.currentNode);
          for (const line of range.getClientRects()) {
            expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
            expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
            expect(line.top).toBeGreaterThanOrEqual(bounds.top - 1);
            expect(line.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
          }
        }
      }
    };
    targets();
    await userEvent.click(await revisions.findByRole('button', { name: m.changes_more() }));
    await waitFor(() => expect(revisions.getByRole('button', { name: m.changes_more() })).toBeEnabled());
    expect(revisions.getAllByRole('listitem')).toHaveLength(2);
    expect(revisions.getByText(m.changes_proposal())).toBeTruthy();
    expect(revisions.getByText(m.changes_acceptance())).toBeTruthy();
    targets();
    await userEvent.click(await revisions.findByRole('button', { name: m.changes_more() }));
    const revision = await revisions.findByRole('button', {
      name: new RegExp(m.changes_revision({ revision: '2' })),
    });
    expect(within(revision).getByText(m.changes_recorded())).toBeTruthy();
    expect(within(revision).queryByText(m.changes_adoption())).toBeNull();
    expect(revisions.getAllByRole('listitem')).toHaveLength(3);
    expect(revisions.queryByRole('button', { name: m.changes_more() })).toBeNull();
    targets();
    await userEvent.click(revision);
    const detail = within(await canvas.findByRole('region', { name: m.changes_revision({ revision: '2' }) }));
    expect(await detail.findByText(m.changes_terms())).toBeTruthy();
    expect(revision).toHaveAttribute('aria-pressed', 'true');
    const fields = within(detail.getByLabelText(m.changes_fields()));
    expect(within(fields.getByText(m.changes_name()).parentElement!).getByRole('definition')).toHaveTextContent(
      languageName('fr', getLocale())!,
    );
    expect(within(fields.getByText(m.changes_description()).parentElement!).getByRole('definition')).toHaveTextContent(
      languageName('en', getLocale())!,
    );
    expect(detail.getByText(m.changes_current_notice())).toBeTruthy();
    expect(canvas.getByRole('link', { name: m.changes_current() }).getAttribute('href')).toContain('/subjects/');
    contained(canvas.getByRole('region', { name: m.changes_revision({ revision: '2' }) }));
    targets();
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

import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ContributionLifecycle } from '../features/catalogue/contribution-lifecycle-view';
import { contributionFixture, type ContributionScenario } from '../kernel/fake/contribution-lifecycle';
import { CandidateValue } from '../features/pages/data';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { subjectTabs } from '../features/pages/views';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import recording from '../kernel/recorded/subject-page.json';
import { AppShell } from '../shell/shell';
import { pagePaths, PatternStory } from './page';

function ContributionStory({ scenario = 'ready' }: { scenario?: ContributionScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => contributionFixture(scenario, locale), [scenario, locale]);
  const [clearedFor, setClearedFor] = useState<string>();
  const identity = `${scenario}:${locale}`;
  const cleared = clearedFor === identity;
  const page = structuredClone(recording) as unknown as SubjectPageData;
  return (
    <SubjectPage
      page={page}
      locale={locale}
      messages={subjectPageMessages()}
      tabs={subjectTabs(page)}
      tabLabels={viewTabLabels()}
      curation={
        scenario === 'empty' ? (
          <p>{m.contribution_empty()}</p>
        ) : (
          <div className="space-y-4">
            {!cleared && (
              <div data-testid="contribution-private-value">
                <CandidateValue
                  snak={fixture.candidate.statement}
                  related={fixture.publicRead.related}
                  locale={locale}
                />
              </div>
            )}
            <ContributionLifecycle
              key={`${scenario}:${locale}`}
              address={fixture.address}
              locale={locale}
              transport={fixture.transport}
              onClear={() => setClearedFor(identity)}
            />
          </div>
        )
      }
    />
  );
}

const meta = {
  title: 'Pages/Catalogue/Contribution lifecycle',
  component: ContributionStory,
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={pagePaths.subject}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Generated-client lifecycle examples on the existing subject page. Native outcome proof and Web/Root visual review remain pending. Use phone390/desktop1280, light/dark and locale globals.',
      },
    },
  },
} satisfies Meta<typeof ContributionStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function withdraw(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const region = within(await canvas.findByRole('region', { name: m.contribution_title() }));
  const button = region.getByRole('button', { name: m.contribution_withdraw() });
  await expect(button).toBeVisible();
  await userEvent.click(button);
  const dialog = await confirmationDialog(canvasElement);
  expect(dialog.getByText(m.contribution_confirm_delete())).toBeTruthy();
  // Intent is confirmed explicitly; opening the confirmation sends no mutation.
  await userEvent.click(dialog.getByRole('button', { name: m.contribution_confirm() }));
  return { canvas, region };
}
async function confirmationDialog(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('alertdialog');
  await waitFor(async () => {
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-open');
  });
  return within(dialog);
}
async function restore(canvasElement: HTMLElement, region: ReturnType<typeof within>) {
  const button = await region.findByRole('button', { name: m.contribution_restore() });
  await waitFor(async () => {
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });
  await userEvent.click(button);
  const dialog = await confirmationDialog(canvasElement);
  await expect(dialog.getByText(m.contribution_confirm_restore())).toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: m.contribution_confirm() }));
}

export const Ready: Story = {};
export const WithdrawAndRestore: Story = {
  play: async ({ canvasElement }) => {
    const { canvas, region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_deleted())).toBeTruthy();
    expect(canvas.queryByTestId('contribution-private-value')).toBeNull();
    expect(region.getByText(m.contribution_subject_available())).toBeTruthy();
    await restore(canvasElement, region);
    expect(await region.findByText(m.contribution_restored())).toBeTruthy();
    expect(region.getByText(m.contribution_unselected())).toBeTruthy();
    expect(canvas.queryByTestId('contribution-private-value')).toBeNull();
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const { canvas, region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_denied())).toBeTruthy();
    expect(canvas.queryByTestId('contribution-private-value')).toBeNull();
    expect(region.queryByRole('button', { name: m.contribution_restore() })).toBeNull();
  },
};
export const Expired: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    await restore(canvasElement, region);
    expect((await region.findAllByText(m.contribution_expired())).length).toBeGreaterThan(0);
    expect(region.queryByRole('button', { name: m.contribution_restore() })).toBeNull();
    expect(region.queryByRole('button', { name: m.contribution_retry() })).toBeNull();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_invalid())).toBeTruthy();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    expect(await region.findByText(m.contribution_unavailable())).toBeTruthy();
    expect(region.queryByText(m.contribution_deleted())).toBeNull();
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    await userEvent.click(await region.findByRole('button', { name: m.contribution_retry() }));
    expect(await region.findByText(m.contribution_deleted())).toBeTruthy();
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    expect(region.getByText(m.contribution_loading())).toBeTruthy();
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const CurrentWithholding: Story = {
  args: { scenario: 'withheld' },
  play: async ({ canvasElement }) => {
    const { region } = await withdraw(canvasElement);
    await restore(canvasElement, region);
    expect(await region.findByText(m.contribution_restored())).toBeTruthy();
    expect(region.getByText(m.contribution_candidate_unconfirmed())).toBeTruthy();
  },
};

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { StatementConsentPage } from '../features/catalogue/statement-consent-view';
import { consentFixture, type ConsentScenario } from '../kernel/fake/statement-consent';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function Example({
  scenario = 'private',
  locale: suppliedLocale,
}: {
  scenario?: ConsentScenario | 'loading';
  locale?: string;
}) {
  const locale = suppliedLocale ?? getLocale();
  const fixture = useMemo(() => consentFixture(scenario === 'loading' ? 'private' : scenario), [scenario, locale]);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <StatementConsentPage
          key={`${scenario}:${locale}`}
          address={fixture.address}
          locale={locale}
          transport={{
            ...fixture.transport,
            read: scenario === 'loading' ? () => new Promise<never>(() => {}) : fixture.transport.read,
          }}
        />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Statement consent',
  component: Example,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'A private review of one native candidate. These declared samples exercise the generated client request seam; they do not prove native eligibility, availability or visual acceptance. Sharing and terminal retraction each require confirmation. Public reading is independent of mutation success. Use locale, theme and viewport globals.',
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
async function open(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.statement_consent_open() }));
  return canvas;
}
async function confirm(canvasElement: HTMLElement, operation: 'disclose' | 'retract' = 'disclose') {
  const canvas = await open(canvasElement);
  await userEvent.click(
    await canvas.findByRole('button', {
      name: operation === 'disclose' ? m.statement_consent_share() : m.statement_consent_retract(),
    }),
  );
  const submit = await canvas.findByRole('button', { name: m.statement_consent_confirm() });
  await expect(submit).toBeDisabled();
  await userEvent.click(await canvas.findByRole('checkbox', { name: m.statement_consent_own() }));
  await userEvent.click(submit);
  return canvas;
}
export const Private: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText('River Ink')).toBeVisible();
    await expect(await canvas.findByText('The person behind the name')).toBeVisible();
    await expect(await canvas.findByText(m.statement_consent_unsourced())).toBeVisible();
    await expect(await canvas.findByText(m.statement_consent_absent())).toBeVisible();
  },
};
export const Confirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.statement_consent_share() }));
    await expect(canvas.getAllByText('River Ink')).toHaveLength(2);
    await expect(canvas.getAllByText('The person behind the name')).toHaveLength(2);
    await expect(await canvas.findByRole('button', { name: m.statement_consent_confirm() })).toBeDisabled();
    await userEvent.click(await canvas.findByRole('button', { name: m.candidate_cancel() }));
    await expect(canvas.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(await canvas.findByRole('button', { name: m.statement_consent_share() }));
  },
};
export const Shared: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_shared())).toBeVisible();
    await expect(await canvas.findByText(m.statement_consent_public())).toBeVisible();
  },
};
export const Retracted: Story = {
  args: { scenario: 'public' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement, 'retract');
    await expect(await canvas.findByText(m.statement_consent_terminal())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.statement_consent_share() })).not.toBeInTheDocument();
    await userEvent.click(await canvas.findByRole('button', { name: m.statement_consent_refresh_public() }));
    await expect(await canvas.findByText(m.statement_consent_absent())).toBeVisible();
  },
};
export const CurrentPublicRead: Story = {
  args: { scenario: 'public' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_public())).toBeVisible();
  },
};
export const Sourced: Story = {
  args: { scenario: 'sourced' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_sourced())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.statement_consent_share() })).not.toBeInTheDocument();
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_empty())).toBeVisible();
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.candidate_loading());
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_denied())).toBeVisible();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.candidate_invalid())).toBeVisible();
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_conflict())).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_uncertain())).toBeVisible();
  },
};
export const RetrySameRequest: Story = {
  args: { scenario: 'lost-response' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.candidate_retry() }));
    await expect(await canvas.findByText(m.statement_consent_shared())).toBeVisible();
  },
};
export const PublicReadUnavailable: Story = {
  args: { scenario: 'read-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_shared())).toBeVisible();
    await expect(await canvas.findByText(m.candidate_public_unconfirmed())).toBeVisible();
  },
};
export const Pending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = await confirm(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_shared())).toBeVisible();
    await expect(await canvas.findByText(m.statement_consent_absent())).toBeVisible();
  },
};

export const IdentityWithheld: Story = {
  args: { scenario: 'identity-withheld' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_identity_help())).toBeVisible();
    await expect(canvas.queryByText('The person behind the name')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: m.statement_consent_share() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.statement_consent_retract() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.candidate_reload() })).toBeEnabled();
  },
};

export const SubjectUnlabelled: Story = {
  args: { scenario: 'subject-unlabelled' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByText(m.statement_consent_identity_help())).toBeVisible();
    await expect(canvas.queryByText('River Ink')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: m.statement_consent_share() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.statement_consent_retract() })).toBeDisabled();
  },
};

export const PrivateReadDenied: Story = {
  args: { scenario: 'read-denied' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.statement_consent_denied());
    await expect(canvas.queryByText('River Ink')).not.toBeInTheDocument();
    await expect(canvas.queryByText('The person behind the name')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: m.statement_consent_share() })).not.toBeInTheDocument();
  },
};

export const RetractionConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    const retract = canvas.getByRole('button', { name: m.statement_consent_retract() });
    await userEvent.click(retract);
    const confirmation = canvas.getByRole('region', { name: m.statement_consent_retract() });
    await expect(within(confirmation).getByText('River Ink')).toBeVisible();
    await expect(within(confirmation).getByText('The person behind the name')).toBeVisible();
    await expect(within(confirmation).getByRole('heading')).toHaveFocus();
    await expect(within(confirmation).getByRole('button', { name: m.statement_consent_confirm() })).toBeDisabled();
    await userEvent.click(within(confirmation).getByRole('button', { name: m.candidate_cancel() }));
    await expect(canvas.getByRole('button', { name: m.statement_consent_retract() })).toHaveFocus();
  },
};

// Independent holders consume the same declared native sample without changing its identities or authority.
function IndependentPanelsExample() {
  const locale = getLocale();
  const first = useMemo(() => consentFixture(), [locale]);
  const second = useMemo(() => consentFixture(), [locale]);
  return (
    <PatternStory visitor="Signed In">
      <AppShell>
        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <div data-consent-panel="first">
            <StatementConsentPage key={locale} address={first.address} locale={locale} transport={first.transport} />
          </div>
          <div data-consent-panel="second">
            <StatementConsentPage key={locale} address={second.address} locale={locale} transport={second.transport} />
          </div>
        </div>
      </AppShell>
    </PatternStory>
  );
}

// Authored UNRUN. These plays exercise actual panels; DOM assertions do not establish target geometry.
export const IndependentPanels: Story = {
  render: () => <IndependentPanelsExample />,
  play: async ({ canvasElement }) => {
    const first = within(canvasElement.querySelector<HTMLElement>('[data-consent-panel="first"]')!);
    const second = within(canvasElement.querySelector<HTMLElement>('[data-consent-panel="second"]')!);
    for (const panel of [first, second]) {
      await userEvent.click(panel.getByRole('button', { name: m.statement_consent_open() }));
      await userEvent.click(await panel.findByRole('button', { name: m.statement_consent_share() }));
    }
    const firstCheckbox = first.getByRole('checkbox', { name: m.statement_consent_own() });
    const secondCheckbox = second.getByRole('checkbox', { name: m.statement_consent_own() });
    await expect(firstCheckbox.id).not.toBe(secondCheckbox.id);
    await userEvent.click(first.getByText(m.statement_consent_own()));
    await expect(first.getByRole('button', { name: m.statement_consent_confirm() })).toBeEnabled();
    await expect(second.getByRole('button', { name: m.statement_consent_confirm() })).toBeDisabled();
    await expect(secondCheckbox).not.toBeChecked();
    await userEvent.click(first.getByRole('button', { name: m.candidate_cancel() }));
    await expect(first.getByRole('button', { name: m.statement_consent_share() })).toHaveFocus();
    await expect(second.getByRole('region', { name: m.statement_consent_share() })).toBeVisible();
    await expect(second.getByRole('button', { name: m.statement_consent_confirm() })).toBeDisabled();
  },
};

export const LongLocalizedConfirmation: Story = {
  args: { locale: 'de' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const options = { locale: 'de' as const };
    await userEvent.click(canvas.getByRole('button', { name: m.statement_consent_open({}, options) }));
    await userEvent.click(await canvas.findByRole('button', { name: m.statement_consent_retract({}, options) }));
    const confirmation = canvas.getByRole('region', { name: m.statement_consent_retract({}, options) });
    await expect(within(confirmation).getByRole('heading', { level: 3 })).toHaveFocus();
    await expect(within(confirmation).getByText(m.statement_consent_retract_help({}, options))).toBeVisible();
    await expect(within(confirmation).getByText('River Ink')).toBeVisible();
    await expect(within(confirmation).getByText('The person behind the name')).toBeVisible();
    await expect(
      within(confirmation).getByRole('button', { name: m.statement_consent_confirm({}, options) }),
    ).toBeDisabled();
  },
};

export const LongLocalizedRecovery: Story = {
  args: { scenario: 'lost-response', locale: 'fr' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const options = { locale: 'fr' as const };
    await userEvent.click(canvas.getByRole('button', { name: m.statement_consent_open({}, options) }));
    await userEvent.click(await canvas.findByRole('button', { name: m.statement_consent_share({}, options) }));
    await userEvent.click(canvas.getByText(m.statement_consent_own({}, options)));
    await userEvent.click(canvas.getByRole('button', { name: m.statement_consent_confirm({}, options) }));
    await expect(await canvas.findByText(m.statement_consent_uncertain({}, options))).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.candidate_retry({}, options) })).toBeEnabled();
    await expect(canvas.getByRole('checkbox')).toHaveAttribute('data-disabled');
    await expect(canvas.queryByRole('button', { name: m.candidate_cancel({}, options) })).not.toBeInTheDocument();
  },
};

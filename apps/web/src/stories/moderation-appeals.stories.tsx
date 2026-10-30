import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ModerationAppealsView } from '../moderation/appeals-tab';
import type { Appeal } from '../moderation/appeals-read';
import type { ModerationTarget } from '../moderation/reports-page';

const meta = {
  title: 'Pages/Moderation appeals',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      viewports: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// This fixed response is copied from the native fixture's successful GET /v1/boards/:id/appeals receipt.
const pendingAppeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  appellantId: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
  statement: 'I did not intend to share identifying information. Please review the decision independently.',
  createdAt: '2026-10-30T01:00:00.000Z',
  decision: {
    statement: 'The reply is withheld while its personal information is reviewed.',
    target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  },
  canResolve: true,
} satisfies Appeal;

// The native post GET returns a denial after takedown, so the real page resolves the target to null.
const withheldTarget: ModerationTarget = {
  key: `post:${pendingAppeal.decision.target.id}`,
  kind: 'post',
  value: null,
};

function makeStory(
  state: 'pending' | 'empty',
  locale: 'en' | 'zh-Hant' | 'zh-Hans' | 'ja' | 'ko' | 'de' | 'fr' | 'es',
  theme: 'light' | 'dark',
  viewport: 'phone390' | 'desktop1280',
): Story {
  const appeals = state === 'pending' ? [pendingAppeal] : [];
  const targets = state === 'pending' ? [withheldTarget] : [];
  return {
    name: `${state} appeal · ${locale} · ${theme} · ${viewport}`,
    globals: { locale, theme },
    parameters: { viewport: { defaultViewport: viewport } },
    render: () => <ModerationAppealsView appeals={appeals} targets={targets} next={null} />,
  };
}

export const PendingEnglishLightPhone: Story = {
  ...makeStory('pending', 'en', 'light', 'phone390'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reports = canvas.getByRole('link', { name: 'Reports', exact: true });
    const statement = canvas.getByRole('textbox', { name: 'Statement', exact: true });
    const uphold = canvas.getByRole('button', { name: 'Uphold', exact: true });
    await userEvent.tab();
    await expect(reports).toHaveFocus();
    await userEvent.tab();
    await expect(statement).toHaveFocus();
    await userEvent.tab();
    await expect(uphold).toHaveFocus();
    await expect(canvas.getByText(pendingAppeal.decision.statement)).toBeInTheDocument();
    await expect(canvas.getByText(pendingAppeal.decision.target.id)).toBeInTheDocument();
    await expect(canvas.getByText(pendingAppeal.statement)).toBeInTheDocument();
  },
};
export const PendingEnglishLightDesktop: Story = makeStory('pending', 'en', 'light', 'desktop1280');
export const PendingEnglishDarkPhone: Story = makeStory('pending', 'en', 'dark', 'phone390');
export const PendingEnglishDarkDesktop: Story = makeStory('pending', 'en', 'dark', 'desktop1280');
export const PendingChineseTraditionalLightPhone: Story = makeStory('pending', 'zh-Hant', 'light', 'phone390');
export const PendingChineseTraditionalLightDesktop: Story = makeStory('pending', 'zh-Hant', 'light', 'desktop1280');
export const PendingChineseSimplifiedLightPhone: Story = makeStory('pending', 'zh-Hans', 'light', 'phone390');
export const PendingChineseSimplifiedLightDesktop: Story = makeStory('pending', 'zh-Hans', 'light', 'desktop1280');
export const PendingJapaneseLightPhone: Story = makeStory('pending', 'ja', 'light', 'phone390');
export const PendingJapaneseLightDesktop: Story = makeStory('pending', 'ja', 'light', 'desktop1280');
export const PendingJapaneseDarkPhone: Story = makeStory('pending', 'ja', 'dark', 'phone390');
export const PendingJapaneseDarkDesktop: Story = makeStory('pending', 'ja', 'dark', 'desktop1280');
export const PendingKoreanLightPhone: Story = makeStory('pending', 'ko', 'light', 'phone390');
export const PendingKoreanLightDesktop: Story = makeStory('pending', 'ko', 'light', 'desktop1280');
export const PendingGermanLightPhone: Story = makeStory('pending', 'de', 'light', 'phone390');
export const PendingGermanLightDesktop: Story = makeStory('pending', 'de', 'light', 'desktop1280');
export const PendingFrenchLightPhone: Story = makeStory('pending', 'fr', 'light', 'phone390');
export const PendingFrenchLightDesktop: Story = makeStory('pending', 'fr', 'light', 'desktop1280');
export const PendingSpanishLightPhone: Story = makeStory('pending', 'es', 'light', 'phone390');
export const PendingSpanishLightDesktop: Story = makeStory('pending', 'es', 'light', 'desktop1280');
export const EmptyEnglishLightPhone: Story = makeStory('empty', 'en', 'light', 'phone390');
export const EmptyEnglishLightDesktop: Story = makeStory('empty', 'en', 'light', 'desktop1280');
export const EmptyEnglishDarkPhone: Story = makeStory('empty', 'en', 'dark', 'phone390');
export const EmptyEnglishDarkDesktop: Story = makeStory('empty', 'en', 'dark', 'desktop1280');
export const EmptyChineseSimplifiedLightPhone: Story = makeStory('empty', 'zh-Hans', 'light', 'phone390');
export const EmptyChineseSimplifiedLightDesktop: Story = makeStory('empty', 'zh-Hans', 'light', 'desktop1280');
export const EmptyChineseSimplifiedDarkPhone: Story = makeStory('empty', 'zh-Hans', 'dark', 'phone390');
export const EmptyChineseSimplifiedDarkDesktop: Story = makeStory('empty', 'zh-Hans', 'dark', 'desktop1280');

import { useCallback } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { resetLoansStoryMode, setLoansStoryMode, type LoansStoryMode } from '../kernel/fake/loans';
import { setCopiesStoryMode } from '../kernel/fake/copies-page-stories';
import { PageStory } from './page';

const meta = {
  title: 'Library/Loans',
  id: 'pages-library-loans',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative contract-shaped fixtures, not native recordings. These stories mount the installed routes and consumers. Use the existing viewport toolbar at phone and desktop widths; navigate with Tab, Enter and Back/Close. No native or visual acceptance is claimed.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function LoansStory({ mode, copy = false }: { mode: LoansStoryMode; copy?: boolean }) {
  const prepareFixture = useCallback(() => {
    setLoansStoryMode(mode);
    if (copy) setCopiesStoryMode('one');
    return () => {
      resetLoansStoryMode();
      if (copy) setCopiesStoryMode('many');
    };
  }, [mode, copy]);
  return (
    <PageStory
      visitor="Signed In"
      path={copy ? '/library/copies' : mode === 'history' ? '/library/loans?filter=history' : '/library/loans'}
      prepareFixture={prepareFixture}
    />
  );
}

export const OpenDueUndated: Story = {
  name: 'Illustrative: open, due and undated',
  render: () => <LoansStory mode="open" />,
  parameters: {
    docs: {
      description: {
        story:
          'Review one row, choose Extend or Mark returned, then Back. Only the chosen operation has fields. Close returns focus to that row. Native row order and supplied dates remain visible.',
      },
    },
  },
};
export const ReturnedHistory: Story = {
  name: 'Illustrative: returned history, deleted and missing copies',
  render: () => <LoansStory mode="history" />,
  parameters: {
    docs: {
      description: {
        story:
          'Returned records survive deleted or missing copies. Review shows terminal history without inventing return or extension permission.',
      },
    },
  },
};
export const ConcealedContext: Story = {
  name: 'Illustrative: concealed people and work context',
  render: () => <LoansStory mode="concealed" />,
  parameters: {
    docs: {
      description: {
        story:
          'Work context is withheld, outside this view or unsupported. Private loans remain visible; concealed people have no identity or destination ID.',
      },
    },
  },
};
export const UnknownExactRetry: Story = {
  name: 'Illustrative: unknown outcome, original receipt retry',
  render: () => <LoansStory mode="uncertain" />,
  parameters: {
    docs: {
      description: {
        story:
          'Review the loan, choose Mark returned and submit the supplied day. The fixture saves the receipt but loses the first acknowledgement. Close and reopen the same row, then Retry original command. It returns that exact receipt, not a second return. Current reads remain explicit.',
      },
    },
  },
};
export const ConflictRecovery: Story = {
  name: 'Illustrative: conflict, explicit current read and fresh review',
  render: () => <LoansStory mode="conflict" />,
  parameters: {
    docs: {
      description: {
        story:
          'The first command conflicts with a changed revision. Refresh current loans beside that refusal, review the changed loan and deliberately choose another operation. This is a new request after a definitive first refusal.',
      },
    },
  },
};
export const SelectedCopyCreation: Story = {
  name: 'Illustrative: record a loan for the selected copy',
  render: () => <LoansStory mode="copy" copy />,
  parameters: {
    docs: {
      description: {
        story:
          'Inspect the copy through the installed Copies route. Review its loan region, choose Record a loan, enter a private counterparty and save. The command captures this copy and revision; loan fields do not join Copy Save.',
      },
    },
  },
};

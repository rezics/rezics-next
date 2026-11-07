import { useContext, useMemo } from 'react';
import {
  unavailableContributionActions,
  type AccountProfilePort,
  type ContributionActionCapabilities,
  type ContributionListInput,
} from '../../features/pages/account-profile-port';

export type { ContributionActionCapabilities };
import { accountCollectionWindowReading } from '../../features/pages/account-page-application';
import type { SubjectPageData } from '../../features/pages/page-model';
import { CollectionWindowsContext, CollectionWindowControls, useCollectionWindows } from './collection-windows/host';
import { ContributionActionsHost, useContributionActionsPageScope } from './contribution-actions/host';
import { contributionActionsWire } from './contribution-actions/actions';
import { ContributionWindowControls } from './contribution-windows/controls';
import { useContributionWindowRoute } from './contribution-windows/route';
import { retireContributionWindow } from './contribution-windows/state';

function bindContributionList(actions: ContributionActionCapabilities) {
  return function ContributionList(input: ContributionListInput) {
    return <ContributionActionsHost {...input} actions={actions} wire={contributionActionsWire} />;
  };
}

/** Bind Threads/Report engines here, alongside the Accounts-owned receipt and session lifetime. */
export function bindAccountProfilePage(
  actions: ContributionActionCapabilities = unavailableContributionActions,
): AccountProfilePort {
  return {
    useCollectionWindow: () => useContext(CollectionWindowsContext) !== null,
    useContributionPage: useContributionActionsPageScope,
    useContributionRoute: () => useContributionWindowRoute() !== null,
    retireContributionWindow: () => {
      if (typeof window !== 'undefined') retireContributionWindow(window);
    },
    CollectionControls: CollectionWindowControls,
    ContributionControls: ContributionWindowControls,
    ContributionList: bindContributionList(actions),
    contributionActions: actions,
  };
}

/** Explicit value installed by PublicProfilePage when the composition root has not bound engines. */
export const accountProfilePageBinding = bindAccountProfilePage();

/** Route lifetime stays above cursor-keyed pages; planning belongs to the page application. */
export function useAccountCollectionWindows({
  page,
  ...input
}: Omit<Parameters<typeof useCollectionWindows>[0], 'reading'> & { page?: SubjectPageData }) {
  const reading = useMemo(() => accountCollectionWindowReading(page), [page]);
  return useCollectionWindows({ ...input, reading });
}

export function AccountCollectionWindowsScope({
  value,
  children,
}: {
  value: ReturnType<typeof useCollectionWindows>;
  children: import('react').ReactNode;
}) {
  return <CollectionWindowsContext.Provider value={value}>{children}</CollectionWindowsContext.Provider>;
}

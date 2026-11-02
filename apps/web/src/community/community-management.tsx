import { createContext, useContext, useEffect, useRef } from 'react';

export type CommunityManagementOperation = 'appearance' | 'bans' | 'space-lifecycle' | 'realm-lifecycle';

/** Panels report their own native result; this region supplies no operation authority. */
export const CommunityManagementContext = createContext<{
  entered: boolean;
  report: (operation: CommunityManagementOperation, admitted: boolean) => void;
} | null>(null);

export function useCommunityManagementAdmission(operation: CommunityManagementOperation, admitted: boolean) {
  const region = useContext(CommunityManagementContext);
  const previouslyEntered = useRef(false);
  if (region?.entered && admitted) previouslyEntered.current = true;
  const report = region?.report;
  useEffect(() => {
    report?.(operation, admitted);
    return () => report?.(operation, false);
  }, [report, operation, admitted]);
  // Closing the region preserves the mounted controller, including drafts and uncertain request keys.
  // A refreshed denial still reaches an entered panel's recovery UI, with its native actions removed.
  return !region || previouslyEntered.current || (region.entered && admitted);
}

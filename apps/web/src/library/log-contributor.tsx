import { AccountRef, type AccountReference } from './account-ref';
import { logContribution, logContributionLabel } from './log-contribution';

function liveName(account: AccountReference | null | undefined, fallback: string): string {
  const name = [account?.displayName, account?.handle ? `@${account.handle}` : null].filter(Boolean).join(' ');
  return name || fallback;
}

export function LogContributor({
  attribution,
  account,
  locale,
}: {
  attribution: unknown;
  account: AccountReference | null;
  locale: string;
}) {
  const contribution = logContribution(attribution);
  if (contribution.kind === 'deleted')
    return <span data-log-contribution="deleted">{logContributionLabel(contribution, locale)}</span>;
  if (contribution.kind === 'live' || account)
    return (
      <span data-log-contribution="live">
        <AccountRef
          account={
            account ?? (contribution.kind === 'live' ? { handle: null, displayName: contribution.displayName } : null)
          }
        />
      </span>
    );
  return <span data-log-contribution="unknown">{logContributionLabel({ kind: 'unknown' }, locale)}</span>;
}

export function logByline(input: { attribution?: unknown; account?: AccountReference | null }, locale: string): string {
  const contribution = logContribution(input.attribution);
  if (contribution.kind === 'deleted') return logContributionLabel(contribution, locale);
  if (contribution.kind === 'live') return liveName(input.account, logContributionLabel(contribution, locale));
  if (input.account) return liveName(input.account, logContributionLabel({ kind: 'unknown' }, locale));
  return logContributionLabel({ kind: 'unknown' }, locale);
}

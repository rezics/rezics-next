import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { normalizeRealmBanTargetHandle } from './realm-ban-target';
import { realmBanEpisodeAdvice } from './realm-ban-current';
import type { InstalledRealmBanPage, RealmBanRow } from './realm-bans';
import { ManagementField, ManagementReference } from './members/management-ui';

type Identity = InstalledRealmBanPage['items'][number]['account'];

/** Only the disclosed canonical account overview is a supported destination. */
export function RealmBanIdentity({
  accountId,
  identity,
  reference = true,
}: {
  accountId: string;
  identity?: Identity | null | undefined;
  reference?: boolean;
}) {
  if (!identity || identity.accountId !== accountId || identity.state !== 'available')
    return (
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {m.realm_bans_details_account()} <ManagementReference>{accountId}</ManagementReference>
      </span>
    );
  const destination =
    identity.handle && normalizeRealmBanTargetHandle(identity.handle) && identity.destination === `/@${identity.handle}`
      ? identity.destination
      : null;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
      {destination ? (
        <a
          className="max-w-full rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href={localizeHref(destination)}
        >
          <bdi>{identity.label}</bdi>
        </a>
      ) : (
        <bdi className="font-medium">{identity.label}</bdi>
      )}
      {identity.handle ? <bdi className="text-sm text-muted-foreground">@{identity.handle}</bdi> : null}
      {reference ? <ManagementReference>{accountId}</ManagementReference> : null}
    </span>
  );
}

export function RealmBanEpisodeView({
  ban,
  includeAccount = true,
}: {
  ban: Readonly<RealmBanRow>;
  includeAccount?: boolean;
}) {
  return (
    <dl className="grid min-w-0 gap-x-6 gap-y-4 sm:grid-cols-2">
      {includeAccount ? (
        <ManagementField label={m.realm_bans_details_account()}>
          <RealmBanIdentity accountId={ban.accountId} identity={ban.account} />
        </ManagementField>
      ) : null}
      <ManagementField label={m.realm_bans_details_moderator()}>
        {ban.actor ? (
          <RealmBanIdentity accountId={ban.actor} identity={ban.moderator} />
        ) : (
          m.realm_bans_moderator_erased()
        )}
      </ManagementField>
      <ManagementField label={m.realm_bans_details_reason()} className="sm:col-span-2">
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{ban.reason || m.realm_bans_no_reason()}</p>
      </ManagementField>
      <ManagementField label={m.realm_bans_details_at()}>
        <time dateTime={ban.at} dir="ltr" className="[overflow-wrap:anywhere]">
          {ban.at.replace('T', ' ').replace(/Z$/, '')} UTC
        </time>
      </ManagementField>
    </dl>
  );
}

export function RealmBanNativeAdvice({ ban, realmId }: { ban: Readonly<RealmBanRow>; realmId: string }) {
  return realmBanEpisodeAdvice(ban, realmId) ? (
    <div className="space-y-2 border-s-2 ps-3 text-sm text-muted-foreground">
      <p>{m.realm_bans_native_advice()}</p>
      <p>{m.realm_bans_unban_confirm()}</p>
    </div>
  ) : null;
}

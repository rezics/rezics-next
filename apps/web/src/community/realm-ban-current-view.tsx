import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { normalizeRealmBanTargetHandle } from './realm-ban-target';
import { realmBanEpisodeAdvice } from './realm-ban-current';
import type { InstalledRealmBanPage, RealmBanRow } from './realm-bans';

type Identity = InstalledRealmBanPage['items'][number]['account'];

/** Only the disclosed canonical account overview is a supported destination. */
export function RealmBanIdentity({
  accountId,
  identity,
}: {
  accountId: string;
  identity?: Identity | null | undefined;
}) {
  if (!identity || identity.accountId !== accountId || identity.state !== 'available')
    return (
      <span>
        {m.realm_bans_details_account()} <bdi>{accountId}</bdi>
      </span>
    );
  const destination =
    identity.handle && normalizeRealmBanTargetHandle(identity.handle) && identity.destination === `/@${identity.handle}`
      ? identity.destination
      : null;
  return (
    <span className="min-w-0 wrap-anywhere">
      {destination ? (
        <a className="text-primary underline" href={localizeHref(destination)}>
          <bdi>{identity.label}</bdi>
        </a>
      ) : (
        <bdi>{identity.label}</bdi>
      )}
      {identity.handle ? (
        <>
          {' '}
          <bdi>@{identity.handle}</bdi>
        </>
      ) : null}{' '}
      <bdi>{accountId}</bdi>
    </span>
  );
}

export function RealmBanEpisodeView({ ban }: { ban: Readonly<RealmBanRow> }) {
  return (
    <dl className="min-w-0 space-y-3">
      <div>
        <dt className="font-medium">{m.realm_bans_details_account()}</dt>
        <dd className="wrap-anywhere">
          <RealmBanIdentity accountId={ban.accountId} identity={ban.account} />
        </dd>
      </div>
      <div>
        <dt className="font-medium">{m.realm_bans_details_moderator()}</dt>
        <dd className="wrap-anywhere">
          {ban.actor ? (
            <RealmBanIdentity accountId={ban.actor} identity={ban.moderator} />
          ) : (
            m.realm_bans_moderator_erased()
          )}
        </dd>
      </div>
      <div>
        <dt className="font-medium">{m.realm_bans_details_reason()}</dt>
        <dd className="whitespace-pre-wrap wrap-anywhere">{ban.reason || m.realm_bans_no_reason()}</dd>
      </div>
      <div>
        <dt className="font-medium">{m.realm_bans_details_at()}</dt>
        <dd>
          <time dateTime={ban.at} dir="ltr" className="wrap-anywhere">
            {ban.at.replace('T', ' ').replace(/Z$/, '')} UTC
          </time>
        </dd>
      </div>
    </dl>
  );
}

export function RealmBanNativeAdvice({ ban, realmId }: { ban: Readonly<RealmBanRow>; realmId: string }) {
  return realmBanEpisodeAdvice(ban, realmId) ? (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>{m.realm_bans_native_advice()}</p>
      <p>{m.realm_bans_unban_confirm()}</p>
    </div>
  ) : null;
}

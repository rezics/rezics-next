import type { AccountDiscoverySummary } from '../discovery';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';

export function AccountBiography({ account, locale }: { account: AccountDiscoverySummary; locale: string }) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const biography = account.context?.biography;
  return (
    <>
      {account.automated ? <p className="text-sm">{m.discovery_account_automated({}, options)}</p> : null}
      {biography?.state === 'available' ? (
        <>
          <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{biography.text}</p>
          {biography.truncated ? (
            <p className="text-sm text-muted-foreground">{m.discovery_account_bio_truncated({}, options)}</p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {biography?.state === 'absent'
            ? m.discovery_account_bio_absent({}, options)
            : biography?.state === 'withheld'
              ? m.discovery_account_bio_withheld({}, options)
              : m.discovery_account_bio_unavailable({}, options)}
        </p>
      )}
    </>
  );
}

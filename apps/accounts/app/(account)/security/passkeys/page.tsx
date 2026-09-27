import { renderAccountPage } from '../../../../features/account/account-page.tsx';
import { SectionHeading } from '../../../../features/account/account-shell.tsx';
import { Passkeys } from '../../../../features/account/passkeys.tsx';
import { passkeyViews } from '../../../../features/account/views.ts';
import { ReadStatePanel } from '../../../../features/shell/state-panel.tsx';

export default async function PasskeysPage() {
  return renderAccountPage('security', ({ methods, locale, now, t }) => methods.status === 'ok'
    ? <Passkeys passkeys={passkeyViews(methods.data.passkeys, now, locale)} hasPassword={methods.data.password} />
    : <><SectionHeading back={{ href: '/security', label: t.security }} title={t.passkeysTitle} />
      <ReadStatePanel status={methods.status} next="/security/passkeys" /></>, '/security/passkeys');
}

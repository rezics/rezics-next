'use client';

import { AppWindowIcon, BadgeCheckIcon, CircleAlertIcon, FingerprintIcon, KeyRoundIcon, LockKeyholeIcon,
  LogInIcon, LogOutIcon, type LucideIcon, MailIcon, ShieldCheckIcon, ShieldOffIcon, UserCogIcon } from 'lucide-react';
import { type ActivityEntry, type ActivityKind, reviewable } from './activity.ts';
import { useDeviceName } from './devices.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** An activity entry with its time already localized on the server. */
export interface ActivityView extends ActivityEntry { when: string }

const icons: Record<ActivityKind, LucideIcon> = {
  'signed-in': LogInIcon, 'sign-in-failed': CircleAlertIcon, 'signed-out': LogOutIcon,
  'device-signed-out': LogOutIcon, 'password-changed': LockKeyholeIcon, 'password-added': LockKeyholeIcon,
  'password-removed': LockKeyholeIcon, 'passkey-added': FingerprintIcon, 'passkey-removed': FingerprintIcon,
  'passkey-renamed': FingerprintIcon, 'two-step-on': ShieldCheckIcon, 'two-step-off': ShieldOffIcon,
  'authenticator-renamed': ShieldCheckIcon, 'backup-codes-changed': KeyRoundIcon, 'email-changed': MailIcon,
  'app-connected': AppWindowIcon, 'app-removed': AppWindowIcon, administrator: UserCogIcon,
};

export const SECURE_ACCOUNT_PATH = '/security/secure-account';

/** Security events, newest first; the ones someone else could have caused
 * offer "Wasn't you?". */
export function ActivityList({ entries, apps = {} }: { entries: ActivityView[];
  /** Names of connected Apps by client ID; an App no longer connected stays unnamed. */
  apps?: Record<string, string> }) {
  const { t } = useTranslation('account');
  const deviceName = useDeviceName();
  const title = (entry: ActivityView): string => {
    switch (entry.kind) {
      case 'signed-in': return entry.method ? t.activitySignedInWith({ method: t[methodNames[entry.method]] })
        : t.activitySignedIn;
      case 'sign-in-failed': return t.activitySignInFailed(entry.count);
      case 'device-signed-out': return t.activityDevicesSignedOut(entry.count);
      case 'app-connected': case 'app-removed': {
        const app = entry.clientId ? apps[entry.clientId] : undefined;
        if (app) return entry.kind === 'app-connected' ? t.activityAppConnectedNamed({ app }) : t.activityAppRemovedNamed({ app });
        return t[titles[entry.kind]];
      }
      default: return t[titles[entry.kind]];
    }
  };
  if (!entries.length) {
    return <div className="flex items-start gap-4 px-5 py-5 sm:px-6">
      <BadgeCheckIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="flex-1 text-muted-foreground">{t.activityEmpty}</p>
    </div>;
  }
  return <ul className="divide-y divide-border/60">
    {entries.map(entry => {
      const Icon = icons[entry.kind];
      const warn = entry.kind === 'sign-in-failed';
      const device = entry.browser || entry.platform ? deviceName(entry) : null;
      return <li key={entry.id} className="flex items-start gap-4 px-5 py-4 sm:px-6">
        <span className={warn ? 'grid size-10 shrink-0 place-items-center rounded-full bg-warning/12 text-warning-foreground'
          : 'grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground'}>
          <Icon className="size-5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title(entry)}</p>
          <p className="text-sm text-muted-foreground">
            <time dateTime={entry.occurredAt}>{entry.when}</time>
            {device ? <> · {device}</> : null}
            {entry.network ? <> · <span className="tabular-nums">{t.network({ network: entry.network })}</span></> : null}
          </p>
        </div>
        {reviewable.has(entry.kind) ? <a href={SECURE_ACCOUNT_PATH}
          className="shrink-0 rounded-md py-1 text-sm font-medium text-primary outline-none hover:underline
            focus-visible:ring-[3px] focus-visible:ring-ring/32">{t.wasntYou}</a> : null}
      </li>;
    })}
  </ul>;
}

const methodNames = { password: 'viaPassword', passkey: 'viaPasskey', authenticator: 'viaAuthenticator',
  'backup-code': 'viaBackupCode' } as const;
const titles = {
  'signed-out': 'activitySignedOut', 'password-changed': 'activityPasswordChanged',
  'password-added': 'activityPasswordAdded', 'password-removed': 'activityPasswordRemoved',
  'passkey-added': 'activityPasskeyAdded', 'passkey-removed': 'activityPasskeyRemoved',
  'passkey-renamed': 'activityPasskeyRenamed', 'two-step-on': 'activityTwoStepOn', 'two-step-off': 'activityTwoStepOff',
  'authenticator-renamed': 'activityAuthenticatorRenamed', 'backup-codes-changed': 'activityBackupCodes',
  'email-changed': 'activityEmailChanged', 'app-connected': 'activityAppConnected', 'app-removed': 'activityAppRemoved',
  administrator: 'activityAdministrator',
} as const satisfies Record<Exclude<ActivityKind, 'signed-in' | 'sign-in-failed' | 'device-signed-out'>, string>;

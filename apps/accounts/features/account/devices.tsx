'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { CircleCheckIcon, LaptopIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface DeviceView {
  id: string;
  thisDevice: boolean;
  browser: string | null;
  platform: string | null;
  /** The coarse network the session signed in from, such as 192.0.2.0/24. */
  network: string | null;
  /** Relative times, already localized on the server. */
  signedIn: string;
  lastActive: string;
}

export type DevicesView = { status: 'ok'; items: DeviceView[] } | { status: 'unavailable' };

const icons = { phone: SmartphoneIcon, computer: LaptopIcon, unknown: MonitorIcon };
const kind = (platform: string | null) => platform === 'iOS' || platform === 'Android' ? 'phone'
  : platform ? 'computer' : 'unknown';

/** "Chrome on macOS", or as much of it as the browser told us. */
export function useDeviceName() {
  const { t } = useTranslation('account');
  return ({ browser, platform }: { browser: string | null; platform: string | null }) =>
    browser && platform ? t.deviceOn({ browser, os: platform }) : browser ?? platform ?? t.unknownDevice;
}

/** Where the account is signed in: this device first, then the rest by last
 * activity; each can be signed out after the person confirms it's them. */
export function Devices({ devices }: { devices: DevicesView }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  const name = useDeviceName();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState('');
  const [signedOut, setSignedOut] = useState(false);

  async function run(key: string, action: () => ReturnType<typeof api.revokeOtherSessions>) {
    setBusy(key);
    setFailure('');
    setSignedOut(false);
    const result = await stepUp(action);
    setBusy(undefined);
    if (result.ok) { setSignedOut(true); refresh(); }
    else if (result.kind !== 'cancelled') setFailure(failureText(result.kind, common));
  }

  if (devices.status !== 'ok') {
    return <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
      <p className="text-muted-foreground">{common.unavailableBody}</p>
      <Button variant="outline" onClick={refresh}>{common.retry}</Button>
    </div>;
  }
  const others = devices.items.filter(item => !item.thisDevice);
  return <>
    <ul className="divide-y divide-border/60">
      {devices.items.map(item => {
        const Icon = icons[kind(item.platform)];
        const title = name(item);
        return <li key={item.id} className="flex items-center gap-4 px-5 py-4 sm:px-6">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
            <Icon className="size-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{item.thisDevice
              ? <span className="inline-flex items-center gap-1.5 font-medium text-success-foreground">
                <CircleCheckIcon className="size-4" aria-hidden="true" />{t.thisDevice}</span>
              : t.lastActive({ time: item.lastActive })}</p>
            <p className="text-sm text-muted-foreground">{t.signedInAt({ time: item.signedIn })}
              {item.network ? <> · <span className="tabular-nums">{t.network({ network: item.network })}</span></> : null}</p>
          </div>
          {item.thisDevice ? null : <Button variant="outline" size="sm" isLoading={busy === item.id}
            disabled={!!busy} aria-label={`${t.signOutDevice} · ${title}`}
            onClick={() => void run(item.id, () => api.revokeSession(item.id))}>{t.signOutDevice}</Button>}
        </li>;
      })}
    </ul>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-4 sm:px-6">
      {others.length ? <Button variant="outline" isLoading={busy === 'others'} disabled={!!busy}
        onClick={() => void run('others', () => api.revokeOtherSessions())}>{t.signOutAll}</Button>
        : <p className="text-sm text-muted-foreground">{t.noOtherDevices}</p>}
    </div>
    {signedOut ? <Alert role="status" variant="success" className="mx-5 mb-4 w-auto sm:mx-6">
      <AlertDescription>{t.devicesSignedOut}</AlertDescription></Alert> : null}
    {failure ? <Alert role="alert" variant="destructive" className="mx-5 mb-4 w-auto sm:mx-6">
      <AlertDescription>{failure}</AlertDescription></Alert> : null}
  </>;
}

'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@rezics/ui/alert-dialog';
import { Button } from '@rezics/ui/button';
import { AppWindowIcon, ChevronRightIcon, CircleCheckIcon, LaptopIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { failureText } from './failure-text.ts';
import { focusedPaths } from './sections.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';

export interface DeviceView {
  id: string;
  ids: string[];
  count: number;
  thisDevice: boolean;
  clientName: string | null;
  browser: string | null;
  platform: string | null;
  /** The coarse network the session signed in from, such as 192.0.2.0/24. */
  network: string | null;
  /** Relative times, already localized on the server. */
  signedIn: string;
  lastActive: string;
  lastActiveAt: string;
}

export type DevicesView = { status: 'ok'; items: DeviceView[] } | { status: 'unavailable' };

const icons = { phone: SmartphoneIcon, computer: LaptopIcon, app: AppWindowIcon, unknown: MonitorIcon };
const kind = (device: Pick<DeviceView, 'platform' | 'browser' | 'clientName'>) =>
  device.platform === 'iOS' || device.platform === 'Android' ? 'phone' : device.platform ? 'computer'
    : device.clientName && !device.browser ? 'app' : 'unknown';

/** "Chrome on macOS", or as much of it as the browser told us. */
export function useDeviceName() {
  const { t } = useTranslation('account');
  return ({ browser, platform }: { browser: string | null; platform: string | null }) =>
    browser && platform ? t.deviceOn({ browser, os: platform }) : browser ?? platform ?? t.unknownDevice;
}

/** A device's name, and for an App's session the browser and system it ran in. */
function useDeviceTitle() {
  const { t } = useTranslation('account');
  const name = useDeviceName();
  return (item: DeviceView): { title: string; detail: string | null } => {
    if (!item.clientName) return { title: name(item), detail: null };
    // An App calling from a server or script tells us nothing more than its name.
    return item.browser || item.platform ? { title: t.appDevice({ app: item.clientName, device: name(item) }), detail: null }
      : { title: item.clientName, detail: t.appSession };
  };
}

function DeviceRow({ item, detailed, action }: { item: DeviceView; detailed: boolean; action?: ReactNode }) {
  const { t } = useTranslation('account');
  const Icon = icons[kind(item)];
  const { title, detail } = useDeviceTitle()(item);
  return <li className="flex items-center gap-4 px-5 py-4 sm:px-6">
    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
      <Icon className="size-5" aria-hidden="true" /></span>
    <div className="min-w-0 flex-1">
      <p className="truncate font-medium">{title}</p>
      {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      <p className="text-sm text-muted-foreground">{item.thisDevice
        ? <span className="inline-flex items-center gap-1.5 font-medium text-success-foreground">
          <CircleCheckIcon className="size-4" aria-hidden="true" />{t.thisDevice}</span>
        : t.lastActive({ time: item.lastActive })}</p>
      {detailed ? <>
        <p className="text-sm text-muted-foreground">{t.signedInAt({ time: item.signedIn })}
          {item.network ? <> · <span className="tabular-nums">{t.network({ network: item.network })}</span></> : null}</p>
        {item.count > 1 ? <p className="text-sm text-muted-foreground">{t.sessionsInGroup({ value: item.count })}</p> : null}
      </> : null}
    </div>
    {action}
  </li>;
}

function Unavailable() {
  const common = useTranslation('common').t;
  const { refresh } = useAccountClient();
  return <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
    <p className="text-muted-foreground">{common.unavailableBody}</p>
    <Button variant="outline" onClick={refresh}>{common.retry}</Button>
  </div>;
}

/** How many devices the security overview lists before "Manage all devices". */
export const DEVICE_SUMMARY = 3;

/** The security overview's view of where the account is signed in: the first
 * few devices and a way to manage them all, as Google Account's card has. */
export function DeviceSummary({ devices }: { devices: DevicesView }) {
  const { t } = useTranslation('account');
  if (devices.status !== 'ok') return <Unavailable />;
  const others = devices.items.some(item => item.ids.length > 0);
  const hidden = devices.items.length - DEVICE_SUMMARY;
  return <>
    <ul className="divide-y divide-border/60">
      {devices.items.slice(0, DEVICE_SUMMARY).map(item => <DeviceRow key={item.id} item={item} detailed={false} />)}
    </ul>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border/60 px-5 py-3 sm:px-6">
      {others ? null : <p className="text-sm text-muted-foreground">{t.noOtherDevices}</p>}
      <Button variant="link" className="px-0" asChild><a href={focusedPaths.devices}>
        {hidden > 0 ? t.manageAllDevicesMore(hidden) : t.manageAllDevices}<ChevronRightIcon aria-hidden="true" /></a></Button>
    </div>
  </>;
}

/** Where the account is signed in: this device first, then the rest by last
 * activity; each can be signed out, or all at once, after the person
 * confirms it's them. Signing out of everything else asks first.
 * See https://support.google.com/accounts/answer/3067630 */
export function Devices({ devices }: { devices: DevicesView }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  const title = useDeviceTitle();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function run(key: string, action: () => ReturnType<typeof api.revokeOtherSessions>) {
    setBusy(key);
    setFailure('');
    setSignedOut(false);
    const result = await stepUp(action);
    setBusy(undefined);
    setConfirming(false);
    if (result.ok) { setSignedOut(true); refresh(); }
    else if (result.kind !== 'cancelled') setFailure(failureText(result.kind, common));
  }

  if (devices.status !== 'ok') return <Unavailable />;
  const others = devices.items.filter(item => item.ids.length > 0);
  return <>
    <ul className="divide-y divide-border/60">
      {devices.items.map(item => <DeviceRow key={item.id} item={item} detailed
        action={item.ids.length ? <Button variant="outline" size="sm" isLoading={busy === item.id} disabled={!!busy}
          aria-label={`${t.signOutDevice} · ${title(item).title}`}
          onClick={() => void run(item.id, () => api.revokeSessions(item.ids))}>{t.signOutDevice}</Button> : null} />)}
    </ul>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-4 sm:px-6">
      {others.length ? <Button variant="outline" isLoading={busy === 'others'} disabled={!!busy}
        onClick={() => setConfirming(true)}>{t.signOutAll}</Button>
        : <p className="text-sm text-muted-foreground">{t.noOtherDevices}</p>}
      <Button variant="link" className="px-0" asChild><a href={focusedPaths.secureAccount}>{t.unrecognizedDevice}</a></Button>
    </div>
    {signedOut ? <Alert role="status" variant="success" className="mx-5 mb-4 w-auto sm:mx-6">
      <AlertDescription>{t.devicesSignedOut}</AlertDescription></Alert> : null}
    {failure ? <Alert role="alert" variant="destructive" className="mx-5 mb-4 w-auto sm:mx-6">
      <AlertDescription>{failure}</AlertDescription></Alert> : null}
    <AlertDialog open={confirming} onOpenChange={({ open }) => { if (!open && !busy) setConfirming(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.signOutAllTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.signOutAllBody(others.length)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={!!busy} onClick={() => setConfirming(false)}>{t.cancel}</AlertDialogCancel>
          <AlertDialogAction isLoading={busy === 'others'}
            onClick={() => void run('others', () => api.revokeOtherSessions())}>{t.signOutAllConfirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

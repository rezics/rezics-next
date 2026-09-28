'use client';

import { SectionHeading, SettingsCard } from './account-shell.tsx';
import { Devices, type DevicesView } from './devices.tsx';
import { sectionPaths } from './sections.ts';
import { useTranslation } from '../../i18n/client.ts';

/** "Manage all devices": every place the account is signed in, with sign-out. */
export function DevicesPage({ devices }: { devices: DevicesView }) {
  const { t } = useTranslation('account');
  return <>
    <SectionHeading back={{ href: sectionPaths.security, label: t.security }} title={t.devices} intro={t.devicesPageIntro} />
    <SettingsCard title={t.devicesSignedIn}><Devices devices={devices} /></SettingsCard>
  </>;
}

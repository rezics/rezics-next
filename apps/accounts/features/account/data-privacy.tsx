'use client';

import { AppWindowIcon, DownloadIcon, FingerprintIcon, HistoryIcon, LaptopIcon, type LucideIcon, SlidersHorizontalIcon,
  Trash2Icon, UserRoundIcon } from 'lucide-react';
import { SectionHeading, SettingsCard, SettingsLinkRow } from './account-shell.tsx';
import { focusedPaths, sectionPaths } from './sections.ts';
import { useTranslation } from '../../i18n/client.ts';

/** What Account keeps, in the order "Download your data" writes it. */
export const keptData = [
  { icon: UserRoundIcon, text: 'keptAccount' },
  { icon: SlidersHorizontalIcon, text: 'keptPreferences' },
  { icon: FingerprintIcon, text: 'keptMethods' },
  { icon: LaptopIcon, text: 'keptDevices' },
  { icon: AppWindowIcon, text: 'keptApps' },
  { icon: HistoryIcon, text: 'keptActivity' },
] as const satisfies readonly { icon: LucideIcon; text: string }[];

/** What Account keeps, one line each. */
export function KeptData() {
  const { t } = useTranslation('account');
  return <ul className="flex flex-col gap-3 px-5 pb-5 sm:px-6">
    {keptData.map(({ icon: Icon, text }) => <li key={text} className="flex items-start gap-3">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" /><span>{t[text]}</span></li>)}
  </ul>;
}

/** Data & privacy, as Google Account arranges it: the options (download,
 * app access, delete) first, then what the account keeps and why. Download
 * and deletion are each a guided page of their own.
 * See https://support.google.com/accounts/answer/7660719 */
export function DataPrivacy({ apps }: { apps: number | null }) {
  const { t } = useTranslation('account');
  const icon = (Icon: LucideIcon) => <Icon className="size-4" aria-hidden="true" />;
  return <>
    <SectionHeading title={t.dataPrivacy} intro={t.privacyIntro} />
    <div className="flex flex-col gap-6">
      <SettingsCard title={t.privacyOptions} description={t.privacyOptionsBody}>
        <SettingsLinkRow label={t.downloadTitle} href={focusedPaths.download} icon={icon(DownloadIcon)}>
          {t.downloadRowBody}</SettingsLinkRow>
        <SettingsLinkRow label={t.connectedApps} href={sectionPaths['connected-apps']} icon={icon(AppWindowIcon)}>
          {apps === null ? t.appsIntro : t.appsCardBody(apps)}</SettingsLinkRow>
        <SettingsLinkRow label={t.deleteRow} href={focusedPaths.deleteAccount} icon={icon(Trash2Icon)}>
          {t.deleteRowBody}</SettingsLinkRow>
      </SettingsCard>
      <SettingsCard title={t.keptTitle} description={t.keptBody}><KeptData /></SettingsCard>
    </div>
  </>;
}

'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { DownloadIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { SectionHeading, SettingsCard } from './account-shell.tsx';
import { KeptData } from './data-privacy.tsx';
import { failureText } from './failure-text.ts';
import { sectionPaths } from './sections.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** "Download your data": what the file holds, what it doesn't, then one
 * button that confirms it's the person and saves the file. The download is
 * recorded in the person's security activity. */
export function DownloadData() {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const { api, download } = useAccountClient();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>();

  async function run() {
    setBusy(true);
    setOutcome(undefined);
    const result = await stepUp(() => api.exportData());
    setBusy(false);
    if (result.ok) {
      download(result.data.file, result.data.name);
      return setOutcome({ ok: true, text: t.downloadStarted({ name: result.data.name }) });
    }
    if (result.kind === 'cancelled') return;
    setOutcome({ ok: false, text: result.kind === 'rate-limited' ? t.downloadRateLimited : failureText(result.kind, common) });
  }

  return <>
    <SectionHeading back={{ href: sectionPaths['data-privacy'], label: t.dataPrivacy }} title={t.downloadTitle}
      intro={t.downloadIntro} />
    <div className="flex flex-col gap-6">
      <SettingsCard title={t.downloadIncluded}>
        <KeptData />
        <p className="flex items-start gap-3 px-5 py-4 text-sm text-muted-foreground sm:px-6">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t.downloadNotIncluded}</p>
      </SettingsCard>
      <SettingsCard title={t.downloadGetTitle}>
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
          <p>{t.downloadFormat}</p>
          <p className="text-muted-foreground">{t.downloadPrivate}</p>
          {outcome ? <Alert role={outcome.ok ? 'status' : 'alert'} variant={outcome.ok ? 'success' : 'destructive'}>
            <AlertDescription>{outcome.text}</AlertDescription></Alert> : null}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p className="me-auto text-sm text-muted-foreground">{t.downloadConfirmNote}</p>
            <Button size="lg" isLoading={busy} onClick={() => void run()}>
              <DownloadIcon aria-hidden="true" />{busy ? t.downloading : t.downloadButton}</Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  </>;
}

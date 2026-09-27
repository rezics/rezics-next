'use client';

import { Button } from '@rezics/ui/button';
import { StatePanel } from '../features/shell/state-panel.tsx';
import { useTranslation } from '../i18n/client.ts';

export default function ErrorPage({ reset }: { error: Error; reset(): void }) {
  const { t } = useTranslation('common');
  return <main className="aura-canvas grid min-h-dvh place-items-center px-4">
    <StatePanel icon="unavailable" title={t.unavailableTitle} body={t.unavailableBody} headingLevel={1}
      className="w-full max-w-lg" action={<Button variant="outline" size="lg" onClick={reset}>{t.retry}</Button>} />
  </main>;
}

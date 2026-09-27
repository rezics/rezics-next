'use client';

import { Button } from '@rezics/ui/button';
import { StatePanel } from './state-panel.tsx';
import { useTranslation } from '../../i18n/client.ts';

export function NotFoundState() {
  const { t } = useTranslation('common');
  return <main className="aura-canvas grid min-h-dvh place-items-center px-4">
    <StatePanel icon="notFound" title={t.notFoundTitle} body={t.notFoundBody} headingLevel={1}
      className="w-full max-w-lg" action={<Button asChild size="lg"><a href="/">{t.backToAccount}</a></Button>} />
  </main>;
}

'use client';

import { Button } from '@rezics/ui/button';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../../i18n/define.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { useLibrary } from '../library-context.tsx';
import type { LibraryMessages } from '../messages.ts';
import { CopyDialog, LendDialog } from './dialogs.tsx';

/** "I own a copy" and "Lend" on a library row. Both stay private to this reader. */
export function CopyLoanActions({ work, title, locale, messages }: {
  work: string; title: string; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const { announce, refresh } = useLibrary();
  const router = useRouter();
  const [copyOpen, setCopyOpen] = useState(false);
  const [lendOpen, setLendOpen] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <div className="grid gap-2">
    <Button type="button" size="sm" variant="outline" className="h-auto w-full max-w-44 whitespace-normal sm:w-44"
      data-hydrated={ready ? 'true' : undefined} aria-label={`${t.ownCopy}, ${title}`}
      onClick={() => setCopyOpen(true)}>{t.ownCopy}</Button>
    <Button type="button" size="sm" variant="outline" className="h-auto w-full max-w-44 whitespace-normal sm:w-44" onClick={() => setLendOpen(true)}
      aria-label={`${t.lend}, ${title}`}>
      {t.lend}</Button>
    <CopyDialog work={work} title={title} open={copyOpen} onOpenChange={setCopyOpen} locale={locale} messages={messages}
      onSaved={() => { announce({ tone: 'default', text: t.copySaved }); refresh(); }} />
    <LendDialog work={work} title={title} open={lendOpen} onOpenChange={setLendOpen} locale={locale} messages={messages}
      onSaved={() => {
        announce({ tone: 'default', text: t.loanSaved });
        refresh();
        router.push(localizedPath('/library/loans', locale));
      }} />
  </div>;
}

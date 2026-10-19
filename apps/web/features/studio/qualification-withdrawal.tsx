'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Undo2Icon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type AuthorFailure, authorFailure } from '../feed/author-api.ts';
import { authorMessages } from '../feed/author-messages.ts';
import { browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { type ChapterPublication, type ChapterTarget, type QualificationWithdrawalIntent,
  type QualificationWithdrawalReceipt, withdrawChapterQualification } from './content-api.ts';
import { browserStorage } from './local-draft.ts';
import { idOf, type MainClient } from './types.ts';

export interface QualificationWithdrawalProps {
  target: ChapterTarget;
  current: ChapterPublication;
  locale: UiLocale;
  main?: MainClient;
  onWithdrawn: (receipt: QualificationWithdrawalReceipt) => void;
}

/** This acts on Content qualification, independently of Work publication and Structure removal. */
export function QualificationWithdrawal({ target, current, locale, main, onWithdrawn }: QualificationWithdrawalProps) {
  const t = authorMessages[locale];
  const router = useRouter();
  const pathname = usePathname();
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<QualificationWithdrawalIntent | null>(null);
  const busyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AuthorFailure | null>(null);
  const [receipt, setReceipt] = useState<QualificationWithdrawalReceipt | null>(null);
  const [deviceFailed, setDeviceFailed] = useState(false);
  const key = `rezics:qualification-withdrawal:v1:${target.actingSubject}:${target.chapter}:${target.variant}`;

  useEffect(() => {
    try {
      const memory = JSON.parse(browserStorage()?.getItem(key) ?? 'null') as {
        pending?: QualificationWithdrawalIntent; receipt?: QualificationWithdrawalReceipt;
      } | null;
      const intent = memory?.pending;
      if (intent && intent.target.actingSubject === target.actingSubject && intent.target.chapter === target.chapter
        && intent.target.variant === target.variant && typeof intent.key === 'string') pending.current = intent;
      if (memory?.receipt?.publication === current.publication && memory.receipt.decision === current.eligibility)
        setReceipt(memory.receipt);
    } catch { /* An unreadable optional cache never supplies a successful receipt. */ }
  }, [key]);

  function remember(result?: QualificationWithdrawalReceipt) {
    try {
      const storage = browserStorage();
      if (!storage) { setDeviceFailed(true); return; }
      storage.setItem(key, JSON.stringify(result ? { receipt: result } : { pending: pending.current }));
      setDeviceFailed(false);
    } catch { setDeviceFailed(true); }
  }

  async function run() {
    if (busyRef.current || !current.eligibility && !pending.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      pending.current ??= { target, current: { ...current, eligibility: current.eligibility! }, key: crypto.randomUUID() };
      remember();
      const result = await withdrawChapterQualification(pending.current, main);
      if (result.kind !== 'done') { setFailure(result.kind); return; }
      setReceipt(result.value);
      pending.current = null;
      remember(result.value);
      onWithdrawn(result.value);
      router.refresh();
    } catch { setFailure('failed'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function readLatest() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const client = main ?? browserMainApi();
      let cursor: string | undefined;
      do {
        const found = await client.v1.works({ id: idOf(target.chapter) })['content-variants'].get({
          query: { actingSubject: target.actingSubject, ...(cursor ? { cursor } : {}) },
        });
        if (!found.data) { setFailure(authorFailure(found.error)); return; }
        if (found.data.authoringSubject !== target.actingSubject) { setFailure('denied'); return; }
        const variant = found.data.items.find(item => item.variantId === target.variant);
        if (variant?.publicationHead && variant.eligibilityHead) {
          pending.current = { target, current: { publication: variant.publicationHead, eligibility: variant.eligibilityHead }, key: crypto.randomUUID() };
          remember();
          setFailure(null);
          return;
        }
        cursor = found.data.nextCursor ?? undefined;
      } while (cursor);
      setFailure('missing');
    } catch { setFailure('failed'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const acknowledged = receipt !== null;
  const close = () => { if (!busyRef.current) setOpen(false); };
  return <>
    <Button ref={trigger} type="button" size="sm" variant="outline" aria-label={t.qualification} title={t.qualification} onClick={() => {
      if (receipt && (receipt.publication !== current.publication
        || current.eligibility !== receipt.decision && current.eligibility !== receipt.withdrawnEligibilityHead)) setReceipt(null);
      setOpen(true);
      if (pending.current) setFailure('failed');
    }}>
      <Undo2Icon aria-hidden="true" /><span className="hidden md:inline">{t.qualification}</span>
    </Button>
    <Dialog open={open} pending={busy} onOpenChange={({ open: next }) => { if (!next) close(); }} finalFocusEl={() => trigger.current}>
      <DialogContent size="md">
        <DialogHeader title={t.qualification} description={t.qualificationHelp} />
        <DialogBody className="grid gap-3">
          {deviceFailed ? <p role="alert" className="text-sm text-warning-foreground">{t.deviceFailed}</p> : null}
          {failure ? <p role="alert" className="text-sm text-destructive-foreground">{failure === 'sign-in' ? t.signIn : t[failure]}</p> : null}
          {acknowledged ? <div role="status" className="grid gap-3 text-sm"><p>{t.qualificationWithdrawn}</p>
              <details><summary>{t.receipt}</summary><p dir="ltr" className="mt-2 break-all font-mono text-xs">{receipt?.receipt}</p></details></div> : null}
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" disabled={busy} onClick={close}>{acknowledged ? t.close : t.cancel}</Button>
          {failure === 'sign-in' ? <a href={signInPath(pathname)} className="rounded-full px-3 py-2 text-sm font-medium underline">{t.signInAction}</a> : null}
          {!acknowledged && failure && ['stale', 'conflict', 'missing', 'invalid'].includes(failure)
            ? <Button disabled={busy} onClick={() => void readLatest()}>{t.reload}</Button>
            : !acknowledged && failure !== 'denied' ? <Button disabled={busy} onClick={() => void run()}>
              {busy ? t.working : failure ? t.retry : t.withdraw}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

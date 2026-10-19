'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { EllipsisIcon, PencilIcon, Undo2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { bodyText, hasBodyContent } from '../document-editor/body.ts';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import { browserStorage } from '../studio/local-draft.ts';
import {
  type AuthorApi, type AuthorFailure, type AuthorReplyBasis, type AuthorReplyTarget,
  mainAuthorApi, type ReplyCorrection, type ReplyWithdrawal,
} from './author-api.ts';
import { authorMessages } from './author-messages.ts';
import { useFeed } from './feed-context.tsx';

interface Memory {
  actor: string;
  reply: string;
  realm: string;
  body: string;
  recoveryBody?: string;
  basis: AuthorReplyBasis | null;
  correction: ReplyCorrection | null;
  withdrawal: ReplyWithdrawal | null;
}

const memoryKey = (actor: string, target: AuthorReplyTarget) =>
  `rezics:author-correction:v1:${actor}:${target.realm}:${target.reply}`;

function restore(actor: string, target: AuthorReplyTarget): Memory | null {
  try {
    const value = JSON.parse(browserStorage()?.getItem(memoryKey(actor, target)) ?? 'null') as Memory | null;
    if (!value || value.actor !== actor || value.reply !== target.reply || value.realm !== target.realm
      || typeof value.body !== 'string') return null;
    // Recovery belongs to the exact actor/object, including when a cached page changes authors.
    for (const intent of [value.correction, value.withdrawal]) {
      if (intent && (intent.actingSubject !== actor || intent.target.reply !== target.reply
        || intent.target.realm !== target.realm || intent.target.author !== actor || typeof intent.key !== 'string')) return null;
    }
    if (value.basis && (value.basis.reply.reply !== target.reply || value.basis.reply.author !== actor
      || value.basis.exact.reference.resourceId !== target.reply)) return null;
    return value;
  } catch { return null; }
}

export interface AuthorActionsProps {
  target: AuthorReplyTarget;
  actingSubject: string | null;
  signedIn: boolean;
  locale: UiLocale;
  signInHref: string;
  api?: AuthorApi;
  onChanged?: () => void;
}

/** Own-object discovery only. All commands are authorized by the existing API owners. */
export function AuthorActions(props: AuthorActionsProps) {
  if (!props.signedIn || !props.actingSubject || props.target.author !== props.actingSubject) return null;
  return <OwnedAuthorActions key={`${props.actingSubject}:${props.target.realm}:${props.target.reply}`} {...props}
    actingSubject={props.actingSubject} />;
}

function OwnedAuthorActions({ target, actingSubject, locale, signInHref, api, onChanged }:
  AuthorActionsProps & { actingSubject: string }) {
  const t = authorMessages[locale];
  const router = useRouter();
  const client = useRef<AuthorApi | null>(api ?? null);
  const getApi = () => client.current ??= mainAuthorApi();
  const trigger = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'edit' | 'withdraw' | null>(null);
  const [basis, setBasis] = useState<AuthorReplyBasis | null>(null);
  const [body, setBody] = useState('');
  const [recoveryBody, setRecoveryBody] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<AuthorFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ kind: 'edit' | 'withdraw'; id: string } | null>(null);
  const [deviceFailed, setDeviceFailed] = useState(false);
  const [editorReady, setEditorReady] = useState(true);
  const correction = useRef<ReplyCorrection | null>(null);
  const withdrawal = useRef<ReplyWithdrawal | null>(null);
  const requestVersion = useRef(0);

  function remember(nextBody = body, nextBasis = basis, retained: string | null = recoveryBody ?? null) {
    try {
      const storage = browserStorage();
      if (!storage) { setDeviceFailed(true); return; }
      storage.setItem(memoryKey(actingSubject, target), JSON.stringify({
        actor: actingSubject, reply: target.reply, realm: target.realm, body: nextBody, recoveryBody: retained ?? undefined, basis: nextBasis,
        correction: correction.current, withdrawal: withdrawal.current,
      } satisfies Memory));
      setDeviceFailed(false);
    } catch { setDeviceFailed(true); }
  }

  async function load(keepBody: boolean, latest = false) {
    const version = ++requestVersion.current;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await getApi().read(latest ? { ...target, revisionId: undefined, placement: undefined } : target, actingSubject);
      if (version !== requestVersion.current) return;
      if (result.kind !== 'done') { setFailure(result.kind); return; }
      setBasis(result.value);
      const nextBody = keepBody ? body : result.value.body;
      setBody(nextBody);
      correction.current = null;
      withdrawal.current = null;
      remember(nextBody, result.value);
      if (latest) setNotice(t.latest);
    } catch { if (version === requestVersion.current) setFailure('failed'); }
    finally { if (version === requestVersion.current) { busyRef.current = false; setBusy(false); } }
  }

  function open(next: 'edit' | 'withdraw') {
    setMode(next);
    setReceipt(null);
    setFailure(null);
    setNotice(null);
    const memory = restore(actingSubject, target);
    correction.current = memory?.correction ?? null;
    withdrawal.current = memory?.withdrawal ?? null;
    if (memory) {
      setBody(memory.body);
      setRecoveryBody(memory.recoveryBody);
      setBasis(memory.basis);
      // A sent request stays frozen across closing, reload and switching menu actions.
      if (memory.correction || memory.withdrawal) {
        setMode(memory.correction ? 'edit' : 'withdraw');
        setFailure('failed');
        return;
      }
      if (memory.basis) return;
    }
    void load(false);
  }

  async function submit() {
    if (busyRef.current || !basis || !mode) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (mode === 'edit') {
        correction.current ??= { key: crypto.randomUUID(), target, actingSubject, basis, body };
        remember();
        const result = await getApi().correct(correction.current, (intent) => {
          correction.current = intent;
          remember();
        });
        if (result.kind !== 'done') { setFailure(result.kind); return; }
        setReceipt({ kind: 'edit', id: result.value.placement });
      } else {
        withdrawal.current ??= { key: crypto.randomUUID(), target, actingSubject,
          placement: basis.placement, revisionId: basis.placedRevision };
        remember();
        const result = await getApi().withdraw(withdrawal.current);
        if (result.kind !== 'done') { setFailure(result.kind); return; }
        setReceipt({ kind: 'withdraw', id: result.value.withdrawal });
      }
      correction.current = null;
      withdrawal.current = null;
      try { browserStorage()?.removeItem(memoryKey(actingSubject, target)); } catch { /* The acknowledged API result remains visible. */ }
      router.refresh();
      onChanged?.();
    } catch { setFailure('failed'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const frozen = Boolean(correction.current || withdrawal.current);
  const canReadLatest = failure && ['stale', 'conflict', 'missing', 'invalid'].includes(failure);
  const close = () => {
    if (busyRef.current) return;
    if (!receipt) remember();
    setMode(null);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return <>
    <Menu onSelect={({ value }) => open(value === 'edit' ? 'edit' : 'withdraw')}>
      <MenuTrigger ref={trigger} aria-label={t.menu}
        className="relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuContent className="max-w-[calc(100vw-2rem)]">
        <MenuItem value="edit"><PencilIcon aria-hidden="true" />{t.edit}</MenuItem>
        <MenuItem value="withdraw"><Undo2Icon aria-hidden="true" />{t.placement}</MenuItem>
      </MenuContent>
    </Menu>
    <Dialog open={mode !== null} pending={busy} onOpenChange={({ open: next }) => { if (!next) close(); }}
      finalFocusEl={() => trigger.current}>
      <DialogContent size={mode === 'edit' ? 'xl' : 'md'}>
        <DialogHeader title={mode === 'edit' ? t.edit : t.placement}
          description={mode === 'edit' ? t.editHelp : t.placementHelp} />
        <DialogBody className="grid min-w-0 gap-4">
          {busy && !basis ? <p role="status">{t.loading}</p> : null}
          {mode === 'edit' && basis && !receipt ? <BodyEditor value={body} locale={locale}
            label={t.body} lang={basis.language} dir={basis.direction === 'none' ? 'auto' : basis.direction}
            readOnly={busy || frozen} compact actingSubject={actingSubject} mediaTarget={basis.reply.rootTarget}
            recoveryValue={recoveryBody}
            onRecoveryChange={(retained) => { setRecoveryBody(retained); remember(body, basis, retained ?? null); }}
            onSaveStateChange={(state) => setEditorReady(state === 'ready')}
            onChange={(next) => { setBody(next); setRecoveryBody(undefined); remember(next, basis, null); }} /> : null}
          {deviceFailed ? <p role="alert" className="text-sm text-warning-foreground">{t.deviceFailed}</p> : null}
          {failure ? <p role="alert" className="text-sm text-destructive-foreground">{failure === 'sign-in' ? t.signIn : t[failure]}</p> : null}
          {notice ? <p role="status" className="text-sm">{notice}</p> : null}
          {receipt ? <div role="status" className="grid gap-2 text-sm">
            <p>{receipt.kind === 'edit' ? t.corrected : t.placementWithdrawn}</p>
            <details><summary className="cursor-pointer font-medium">{t.receipt}</summary>
              <p className="mt-2 break-all font-mono text-xs" dir="ltr">{receipt.id}</p></details>
          </div> : null}
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" disabled={busy} onClick={close}>{receipt ? t.close : t.cancel}</Button>
          {failure === 'sign-in' ? <a href={signInHref} className="rounded-full px-3 py-2 text-sm font-medium underline">{t.signInAction}</a> : null}
          {canReadLatest ? <Button disabled={busy} onClick={() => void load(mode === 'edit', true)}>{t.reload}</Button>
            : !receipt && failure !== 'denied' && failure !== 'sign-in' ? <Button disabled={busy || mode === 'edit' && (!hasBodyContent(body) || bodyText(body).length > 8192 || !editorReady)}
              onClick={() => basis ? void submit() : void load(Boolean(body))}>
              {busy ? t.working : failure ? t.retry : mode === 'edit' ? t.save : t.withdraw}
            </Button> : null}
          {failure === 'sign-in' && basis ? <Button disabled={busy} onClick={() => void submit()}>{t.retry}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

export function ReplyAuthorActions({ target }: { target: AuthorReplyTarget }) {
  const { signedIn, actingSubject, locale, signInHref } = useFeed();
  return <AuthorActions target={target} signedIn={signedIn} actingSubject={actingSubject}
    locale={locale} signInHref={signInHref} />;
}

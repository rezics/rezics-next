import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { CreateSubjectForm } from './create-subject-form';
import type { CreateResult, CreateTransport, CreateType } from './create-subject';
import {
  beginRelatedWorkDraftReturn,
  beginRelatedWorkReturn,
  discardRelatedWorkHandoff,
  readRelatedWorkHandoff,
  recordCreatedRelatedWork,
  relatedWorkTargetAdmitted,
  type CreatedRelatedWork,
  type RelatedWorkHandoff,
} from './related-work-handoff';

type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
type Created = Extract<CreateResult, { ok: true }>;

function createdIdentity(result: Created, bases: string[]): CreatedRelatedWork | undefined {
  const identity = result.reader.state === 'ready' ? result.reader.identity : undefined;
  if (!identity) return undefined;
  return { id: identity.id, type: identity.type, label: identity.label, bases };
}

export function RelatedWorkCreate({
  locale,
  session,
  transport,
  onNavigate,
  token,
  reader,
  readerLive,
  identityIntake,
}: {
  locale: string;
  session: Session;
  transport: CreateTransport;
  onNavigate: (href: string) => void;
  token?: string;
  reader: string;
  readerLive: () => boolean;
  identityIntake?: { viewerKey: string; viewerState: Session };
}) {
  const options = { locale: locale as never };
  const [handoff, setHandoff] = useState<RelatedWorkHandoff>();
  const [offered, setOffered] = useState<CreateType[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [loadedToken, setLoadedToken] = useState<string>();
  const [restoredId, setRestoredId] = useState<string>();
  const [inlineDestination, setInlineDestination] = useState(0);
  const returning = useRef(false);
  const selectedBases = useRef<string[]>([]);
  const pendingOpener = useRef<HTMLElement | null>(null);
  const createRoot = useRef<HTMLDivElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!token) {
      setHandoff(undefined);
      setLoadedToken(undefined);
      setRestoredId(undefined);
      return;
    }
    returning.current = false;
    const current = readRelatedWorkHandoff(token);
    if (
      !current ||
      (current.phase !== 'creating' && current.phase !== 'ready') ||
      current.reader !== reader ||
      !readerLive()
    ) {
      discardRelatedWorkHandoff(token);
      setHandoff(undefined);
      setRestoredId(undefined);
      setLoadedToken(token);
      return;
    }
    setRestoredId(current.createdId);
    setHandoff(current);
    setLoadedToken(token);
    return () => {
      if (!returning.current) discardRelatedWorkHandoff(token);
    };
  }, [token, reader, readerLive]);

  useEffect(() => {
    const clear = (event: Event) => {
      if (event.type !== 'focusin' || event.target !== pendingOpener.current) pendingOpener.current = null;
    };
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('focusin', clear, true);
    return () => {
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('focusin', clear, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!inlineDestination) return;
    const opener = pendingOpener.current;
    pendingOpener.current = null;
    if (!opener) return;
    const target =
      returnButton.current ?? createRoot.current?.querySelector<HTMLElement>('section[role="status"][tabindex="-1"]');
    if (!target?.isConnected || !target.getClientRects().length) return;
    const active = target.ownerDocument.activeElement;
    if (active === opener || active === target.ownerDocument.body || active === target.ownerDocument.documentElement)
      target.focus();
  }, [inlineDestination]);

  useEffect(() => {
    const current = handoff?.token === token ? handoff : undefined;
    const directory = transport.typeDirectory;
    if (!current || !directory) {
      setOffered([]);
      setUnavailable([]);
      return;
    }
    let cancelled = false;
    void Promise.all(current.targets.map((type) => directory.descriptor(type))).then((results) => {
      if (cancelled) return;
      const nextOffered: CreateType[] = [];
      const nextUnavailable: string[] = [];
      current.targets.forEach((type, index) => {
        const result = results[index];
        if (result?.ok && relatedWorkTargetAdmitted(result.type.id, result.type.bases ?? [], current.targets))
          nextOffered.push(result.type);
        else nextUnavailable.push(type);
      });
      setOffered(nextOffered);
      setUnavailable(nextUnavailable);
    });
    return () => {
      cancelled = true;
    };
  }, [handoff, transport.typeDirectory]);

  function recordCreated(result: Created) {
    const current = handoff?.token === token ? handoff : undefined;
    if (!current || !readerLive()) return;
    const next = recordCreatedRelatedWork(
      current.token,
      current.workId,
      current.reader,
      result.id,
      createdIdentity(result, selectedBases.current),
    );
    if (!next) {
      discardRelatedWorkHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    setHandoff(next);
    const identity = result.reader.state === 'ready' ? result.reader.identity : undefined;
    if (next.phase === 'creating' && identity?.id === result.id && transport.typeDirectory) {
      // A restored acknowledgement has no in-memory Type bases. Re-read its exact descriptor.
      void transport.typeDirectory
        .descriptor(identity.type)
        .then((descriptor) => {
          if (!descriptor.ok || descriptor.type.id !== identity.type || !readerLive()) return;
          const admitted = recordCreatedRelatedWork(current.token, current.workId, current.reader, result.id, {
            ...identity,
            bases: descriptor.type.bases ?? [],
          });
          if (admitted) setHandoff(admitted);
        })
        .catch(() => undefined);
    }
  }

  function returnWithIdentity(identity: CreatedRelatedWork) {
    const current = handoff?.token === token ? handoff : undefined;
    if (
      !current ||
      current.identity?.id !== identity.id ||
      current.reader !== reader ||
      !readerLive() ||
      !beginRelatedWorkReturn(current.token, current.workId, reader)
    ) {
      if (current) discardRelatedWorkHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    returning.current = true;
    window.location.assign(
      `${subjectHref({ id: current.workId, label: current.sourceLabel }, locale).href}/relation-edit?relatedWorkHandoff=${encodeURIComponent(current.token)}`,
    );
  }

  function returnDraft() {
    const current = handoff?.token === token ? handoff : undefined;
    if (!current || !readerLive() || !beginRelatedWorkDraftReturn(current.token, current.workId, reader)) {
      if (current) discardRelatedWorkHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    returning.current = true;
    window.location.assign(
      `${subjectHref({ id: current.workId, label: current.sourceLabel }, locale).href}/relation-edit?relatedWorkHandoff=${encodeURIComponent(current.token)}`,
    );
  }

  const visibleHandoff = loadedToken === token ? handoff : undefined;
  const returnedIdentity = visibleHandoff?.phase === 'ready' ? visibleHandoff.identity : undefined;
  const sourceHref = visibleHandoff
    ? subjectHref({ id: visibleHandoff.workId, label: visibleHandoff.sourceLabel }, locale).href
    : undefined;

  return (
    <div
      className="space-y-6"
      onKeyDownCapture={(event) => {
        if (!token || (event.key !== 'Enter' && event.key !== ' ')) return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const submitter = target.closest<HTMLElement>('button[type="submit"], input[type="submit"], input[type="image"]');
        if (submitter) pendingOpener.current = submitter;
        else if (event.key === 'Enter' && target instanceof HTMLInputElement &&
          !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(target.type))
          pendingOpener.current = target;
      }}
      onClickCapture={(event) => {
        if (!token) return;
        const target = event.target;
        const button = target instanceof Element ? target.closest<HTMLElement>('button') : null;
        if (button && createRoot.current?.contains(button))
          pendingOpener.current = event.detail === 0 && event.nativeEvent.isTrusted ? button : null;
      }}
    >
      {token && loadedToken === token && !visibleHandoff && <p role="alert">{m.related_work_handoff_invalid({}, options)}</p>}
      {visibleHandoff && (
        <section aria-labelledby={titleId} className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {m.related_work_source({}, options)}
          </h2>
          <p>
            {m.related_work_create_context({ relation: visibleHandoff.propertyLabel, source: visibleHandoff.sourceLabel }, options)}
          </p>
          {sourceHref && (
            <a className={`${buttonVariants({ variant: 'outline' })}`} href={sourceHref}>
              {visibleHandoff.sourceLabel || visibleHandoff.workId}
            </a>
          )}
          <p className="text-sm text-muted-foreground">{m.related_work_distinct({}, options)}</p>
        </section>
      )}
      {(!token || visibleHandoff) && <div ref={createRoot}><CreateSubjectForm
        locale={locale}
        session={session}
        transport={transport}
        onCreated={(result) => {
          if (visibleHandoff) recordCreated(result);
        }}
        onNavigate={visibleHandoff ? () => setInlineDestination((value) => value + 1) : onNavigate}
        {...(restoredId ? { restoredAcknowledgementId: restoredId } : {})}
        {...(!token && identityIntake ? { identityIntake } : {})}
        {...(visibleHandoff
          ? {
              typeAdmission: {
                offered,
                unavailable,
                admitType: (type: CreateType) => {
                  const admitted = relatedWorkTargetAdmitted(type.id, type.bases ?? [], visibleHandoff.targets);
                  if (admitted) selectedBases.current = type.bases ?? [];
                  return admitted;
                },
              },
            }
          : {})}
      /></div>}
      {returnedIdentity && (
        <div className="flex flex-wrap gap-3">
          <Button ref={returnButton} type="button" variant="outline" onClick={() => returnWithIdentity(returnedIdentity)}>
            {m.related_work_return_to_draft({}, options)}
          </Button>
          {restoredId && <a className={buttonVariants({ variant: 'outline' })} href={subjectHref(returnedIdentity, locale).href}>
            {m.catalogue_create_open({}, options)}
          </a>}
        </div>
      )}
      {visibleHandoff && visibleHandoff.phase === 'creating' && !visibleHandoff.createdId && (
        <Button type="button" variant="outline" onClick={() => setConfirmLeave(true)}>
          {m.related_work_cancel({}, options)}
        </Button>
      )}
      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.related_work_cancel({}, options)}</AlertDialogTitle>
            <AlertDialogDescription>{m.related_work_cancel_confirm({}, options)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.thread_authoring_stay({}, options)}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={returnDraft}>
              {m.related_work_cancel({}, options)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
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
  const returning = useRef(false);
  const selectedBases = useRef<string[]>([]);
  const titleId = useId();

  useEffect(() => {
    if (!token) {
      setHandoff(undefined);
      return;
    }
    returning.current = false;
    const current = readRelatedWorkHandoff(token);
    if (!current || current.phase !== 'creating' || current.reader !== reader || !readerLive()) {
      discardRelatedWorkHandoff(token);
      setHandoff(undefined);
      return;
    }
    setHandoff(current);
    return () => {
      if (!returning.current) discardRelatedWorkHandoff(token);
    };
  }, [token, reader, readerLive]);

  useEffect(() => {
    const current = handoff;
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
    const current = handoff;
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
  }

  function returnWithIdentity(identity: CreatedRelatedWork) {
    const current = handoff;
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
    const current = handoff;
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

  const returnedIdentity = handoff?.phase === 'ready' ? handoff.identity : undefined;
  const sourceHref = handoff ? subjectHref({ id: handoff.workId, label: handoff.sourceLabel }, locale).href : undefined;

  return (
    <div className="space-y-6">
      {token && !handoff && <p role="alert">{m.related_work_handoff_invalid({}, options)}</p>}
      {handoff && (
        <section aria-labelledby={titleId} className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {m.related_work_source({}, options)}
          </h2>
          <p>
            {m.related_work_create_context({ relation: handoff.propertyLabel, source: handoff.sourceLabel }, options)}
          </p>
          {sourceHref && (
            <a className={`${buttonVariants({ variant: 'outline' })}`} href={sourceHref}>
              {handoff.sourceLabel || handoff.workId}
            </a>
          )}
          <p className="text-sm text-muted-foreground">{m.related_work_distinct({}, options)}</p>
        </section>
      )}
      <CreateSubjectForm
        locale={locale}
        session={session}
        transport={transport}
        onCreated={(result) => {
          if (handoff) recordCreated(result);
        }}
        onNavigate={handoff ? () => {} : onNavigate}
        {...(!token && identityIntake ? { identityIntake } : {})}
        {...(handoff
          ? {
              typeAdmission: {
                offered,
                unavailable,
                admitType: (type: CreateType) => {
                  const admitted = relatedWorkTargetAdmitted(type.id, type.bases ?? [], handoff.targets);
                  if (admitted) selectedBases.current = type.bases ?? [];
                  return admitted;
                },
              },
            }
          : {})}
      />
      {returnedIdentity && (
        <Button type="button" variant="outline" onClick={() => returnWithIdentity(returnedIdentity)}>
          {m.related_work_return_to_draft({}, options)}
        </Button>
      )}
      {handoff && handoff.phase === 'creating' && !handoff.createdId && (
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

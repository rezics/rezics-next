import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { WorkbenchCase } from '../workbench-queue/read';
import { workbenchTriageDetailFields, type WorkbenchTriageField } from './labels';
import { WorkbenchTriageSummary } from './summary';

const control =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words px-3 py-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function DetailValue({ field }: { field: WorkbenchTriageField }) {
  if (field.kind === 'time' && field.iso && field.presence === 'present') {
    return (
      <time
        dateTime={field.iso}
        dir="ltr"
        className="inline-block max-w-full select-text tabular-nums [overflow-wrap:anywhere]"
      >
        {field.value}
      </time>
    );
  }
  if (field.kind === 'code' && field.presence === 'present') {
    return (
      <code dir="ltr" className="break-all">
        {field.value}
      </code>
    );
  }
  return (
    <span
      data-triage-presence={field.presence}
      className={
        field.presence === 'present'
          ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
          : 'text-muted-foreground [overflow-wrap:anywhere]'
      }
    >
      {field.value}
    </span>
  );
}

function DetailList({ item, locale }: { item: WorkbenchCase; locale: string }) {
  const fields = workbenchTriageDetailFields(item, locale);
  return (
    <dl className="mt-3 grid gap-3 text-sm xl:grid-cols-2 xl:gap-x-6 xl:gap-y-3">
      {fields.map((field) => (
        <div key={field.key} className="min-w-0">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="mt-0.5 max-w-prose min-w-0">
            <DetailValue field={field} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function WorkbenchTriageDetails({
  item,
  identity,
  locale = getLocale(),
}: {
  item: WorkbenchCase;
  identity: string;
  locale?: string;
}) {
  const panelId = useId();
  const headingId = useId();
  const openerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const identityRef = useRef(identity);
  const returnFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [boundIdentity, setBoundIdentity] = useState(identity);
  identityRef.current = identity;
  let visible = open;
  if (boundIdentity !== identity) {
    setBoundIdentity(identity);
    setOpen(false);
    visible = false;
    returnFocus.current = false;
  }

  useEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    panel?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = event.target;
      if (active instanceof Node && panel && !panel.contains(active) && active !== openerRef.current) return;
      event.preventDefault();
      returnFocus.current = true;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    if (!returnFocus.current) return;
    returnFocus.current = false;
    const token = identity;
    queueMicrotask(() => {
      if (identityRef.current !== token) return;
      openerRef.current?.focus();
    });
  }, [visible, identity]);

  function close() {
    returnFocus.current = true;
    setOpen(false);
  }

  return (
    <div className="mt-2 min-w-0">
      <Button
        ref={openerRef}
        type="button"
        variant="outline"
        className={`${control} justify-start`}
        aria-expanded={visible}
        aria-controls={panelId}
        onClick={() => {
          if (visible) close();
          else setOpen(true);
        }}
      >
        {visible ? m.moderation_workbench_triage_close() : m.moderation_workbench_triage_inspect()}
      </Button>
      {visible ? (
        <section
          ref={panelRef}
          id={panelId}
          tabIndex={-1}
          aria-labelledby={headingId}
          className="mt-3 min-w-0 rounded-lg border p-3 sm:p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <h3 id={headingId} className="text-sm font-semibold">
            {m.moderation_workbench_triage_details()}
          </h3>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {m.moderation_workbench_triage_report_time_note()}
          </p>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{m.moderation_workbench_triage_timezone()}</p>
          <DetailList item={item} locale={locale} />
          <Button type="button" variant="outline" className={`${control} mt-4 justify-start`} onClick={close}>
            {m.moderation_workbench_triage_close()}
          </Button>
        </section>
      ) : null}
    </div>
  );
}

export function WorkbenchTriageCase({
  item,
  identity,
  locale,
}: {
  item: WorkbenchCase;
  identity: string;
  locale?: string;
}) {
  return (
    <div className="min-w-0">
      <WorkbenchTriageSummary item={item} {...(locale ? { locale } : {})} />
      <WorkbenchTriageDetails item={item} identity={identity} {...(locale ? { locale } : {})} />
    </div>
  );
}

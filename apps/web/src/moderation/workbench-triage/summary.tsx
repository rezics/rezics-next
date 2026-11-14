import type { WorkbenchCase } from '../workbench-queue/read';
import { getLocale } from '../../paraglide/runtime.js';
import { workbenchTriageSummaryFields, type WorkbenchTriageField } from './labels';

function SummaryValue({ field }: { field: WorkbenchTriageField }) {
  if (field.kind === 'time' && field.iso && field.presence === 'present') {
    return (
      <time dateTime={field.iso} dir="ltr" className="inline-block max-w-full tabular-nums [overflow-wrap:anywhere]">
        {field.value}
      </time>
    );
  }
  return (
    <span
      data-triage-presence={field.presence}
      className={
        field.presence === 'present' ? '[overflow-wrap:anywhere]' : 'text-muted-foreground [overflow-wrap:anywhere]'
      }
    >
      {field.value}
    </span>
  );
}

/** The supplied reason and evidence lead; the exact native references live in Details. */
export function WorkbenchTriageSummary({ item, locale = getLocale() }: { item: WorkbenchCase; locale?: string }) {
  const fields = workbenchTriageSummaryFields(item, locale);
  const type = fields.find((field) => field.key === 'type');
  const targetKind = fields.find((field) => field.key === 'target-kind');
  const outcome = fields.find((field) => field.key === 'outcome');
  const reason = fields.find((field) => field.key === 'reason');
  const created = fields.find((field) => field.key === 'created');
  const evidence = fields.find((field) => field.key === 'evidence' || field.key === 'statement');
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {type ? <span>{type.value}</span> : null}
        {targetKind ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{targetKind.value}</span>
          </>
        ) : null}
        {outcome ? (
          <span
            data-triage-presence={outcome.presence}
            className="rounded-md bg-secondary px-2 py-1 font-medium text-secondary-foreground"
          >
            {outcome.value}
          </span>
        ) : null}
        {created ? (
          <span className="basis-full sm:ml-auto sm:basis-auto">
            <SummaryValue field={created} />
          </span>
        ) : null}
      </div>
      {reason ? (
        <p className="text-base font-semibold [overflow-wrap:anywhere]">
          <span className="sr-only">{reason.label}: </span>
          <SummaryValue field={reason} />
        </p>
      ) : null}
      {evidence ? (
        <p className="max-w-prose whitespace-pre-wrap text-sm leading-6 line-clamp-3 [overflow-wrap:anywhere]">
          <span className="sr-only">{evidence.label}: </span>
          <SummaryValue field={evidence} />
        </p>
      ) : null}
    </div>
  );
}

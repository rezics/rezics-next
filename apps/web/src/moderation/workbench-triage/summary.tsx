import type { WorkbenchCase } from '../workbench-queue/read';
import { getLocale } from '../../paraglide/runtime.js';
import {
  workbenchTriageSummaryFields,
  type WorkbenchTriageField,
} from './labels';

function SummaryValue({ field }: { field: WorkbenchTriageField }) {
  if (field.kind === 'time' && field.iso && field.presence === 'present') {
    return (
      <time
        dateTime={field.iso}
        dir="ltr"
        className="inline-block max-w-full tabular-nums [overflow-wrap:anywhere]"
      >
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

/** Compact scan summary. Owners keep their own link and history chrome around this. */
export function WorkbenchTriageSummary({
  item,
  locale = getLocale(),
}: {
  item: WorkbenchCase;
  locale?: string;
}) {
  const fields = workbenchTriageSummaryFields(item, locale);
  const type = fields.find((field) => field.key === 'type');
  const targetKind = fields.find((field) => field.key === 'target-kind');
  const outcome = fields.find((field) => field.key === 'outcome');
  const rest = fields.filter(
    (field) => field.key !== 'type' && field.key !== 'target-kind' && field.key !== 'outcome',
  );
  return (
    <div className="mt-2 min-w-0 space-y-1 text-sm">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        {type ? <span className="font-medium">{type.value}</span> : null}
        {targetKind ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span>{targetKind.value}</span>
          </>
        ) : null}
        {outcome ? (
          <span
            data-triage-presence={outcome.presence}
            className={
              outcome.presence === 'present'
                ? 'rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground'
                : 'text-muted-foreground'
            }
          >
            {outcome.value}
          </span>
        ) : null}
      </p>
      {rest.map((field) => (
        <p
          key={field.key}
          className={`min-w-0 [overflow-wrap:anywhere] ${field.key === 'evidence' || field.key === 'statement' ? 'max-w-prose whitespace-pre-wrap line-clamp-2' : ''}`}
        >
          <span className="text-muted-foreground">{field.label}: </span>
          <SummaryValue field={field} />
        </p>
      ))}
    </div>
  );
}

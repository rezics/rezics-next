import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type {
  InspectionIssue,
  InspectionOutlineEntry,
  InspectionProjection,
  OutlineKind,
  WritingInspection,
} from './writing-inspection';

export const inspectionActionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 text-start leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring';

export function outlineKindLabel(kind: OutlineKind): string {
  switch (kind) {
    case 'heading':
      return m.thread_inspection_heading();
    case 'paragraph':
      return m.thread_inspection_paragraph();
    case 'list':
      return m.thread_inspection_list();
    case 'quote':
      return m.thread_inspection_quote();
    case 'code':
      return m.thread_inspection_code();
    case 'table':
      return m.thread_inspection_table();
    case 'image':
      return m.thread_inspection_image();
    case 'media':
      return m.thread_inspection_media();
    case 'component':
      return m.thread_inspection_component();
    case 'block':
      return m.thread_inspection_block();
  }
}

export function outlineEntryLabel(entry: InspectionOutlineEntry): string {
  const kind = outlineKindLabel(entry.kind);
  return entry.label.trim()
    ? m.thread_inspection_named_block({ kind, text: entry.label })
    : m.thread_inspection_unnamed_block({ kind, number: entry.ordinal });
}

function issueText(issue: InspectionIssue): string {
  switch (issue.kind) {
    case 'empty':
      return m.thread_inspection_empty();
    case 'title-empty':
      return m.thread_inspection_title_empty();
    case 'title-size':
      return m.thread_inspection_title_size();
    case 'images':
      return m.thread_inspection_image_size();
    case 'upload':
      return m.thread_inspection_upload({ count: issue.count ?? 0 });
    case 'attachment':
      return m.thread_inspection_attachment();
    case 'refusal':
      return m.thread_inspection_refusal({ reason: issue.detail ?? '' });
    case 'unknown':
      return m.thread_inspection_unknown();
    case 'sending':
      return m.thread_inspection_sending();
  }
}

/** A bounded navigation list for this one preview, separate from deliberate editor repair. */
export function WritingInspectionOutline({
  projection,
  inspection,
  prefix,
  navigate,
}: {
  projection: InspectionProjection;
  inspection: WritingInspection;
  prefix: string;
  navigate: (entry: InspectionOutlineEntry) => void;
}) {
  const token = inspection.token();
  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-2">
      <nav aria-label={m.thread_inspection_outline()} className="min-w-0 space-y-2">
        <h3 className="font-medium">{m.thread_inspection_outline()}</h3>
        <ol className="max-h-72 min-w-0 space-y-2 overflow-auto rounded-lg border p-2">
          {projection.outline.map((entry) => (
            <li key={entry.ordinal} className="min-w-0" data-inspection-outline-row>
              <div className="flex min-w-0 flex-wrap items-start gap-1">
                <a
                  className={`${inspectionActionClass} flex min-w-0 flex-1 items-center rounded-md underline underline-offset-4`}
                  href={`#${prefix}-block-${entry.ordinal}`}
                  onClick={(event) => {
                    event.preventDefault();
                    if (inspection.matches(token)) navigate(entry);
                  }}
                >
                  {outlineEntryLabel(entry)}
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  className={inspectionActionClass}
                  aria-label={m.thread_inspection_repair_block({ block: outlineEntryLabel(entry) })}
                  onClick={() => inspection.repair(entry.id ?? undefined, false, token)}
                >
                  {m.thread_inspection_repair()}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {projection.outlineTotal > projection.outline.length ? (
          <p className="text-sm text-muted-foreground">
            {m.thread_inspection_outline_omitted({ count: projection.outlineTotal - projection.outline.length })}
          </p>
        ) : null}
      </nav>
      <section aria-label={m.thread_inspection_issues()} className="min-w-0 space-y-2">
        <h3 className="font-medium">{m.thread_inspection_issues()}</h3>
        {projection.issueTotal === 0 ? (
          <p className="text-sm">{m.thread_inspection_no_issues()}</p>
        ) : (
          <ul className="max-h-72 min-w-0 space-y-2 overflow-auto rounded-lg border p-2">
            {projection.issues.map((issue, index) => (
              <li key={index} className="min-w-0 space-y-1 rounded-md bg-muted/40 p-2" data-inspection-diagnostic-row>
                <p>{issueText(issue)}</p>
                {!['unknown', 'sending', 'refusal'].includes(issue.kind) ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={inspectionActionClass}
                    onClick={() =>
                      inspection.repair(
                        issue.kind === 'attachment' ? (issue.id ?? undefined) : undefined,
                        issue.kind.startsWith('title-'),
                        token,
                      )
                    }
                  >
                    {m.thread_inspection_return_repair()}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {projection.issueTotal > projection.issues.length ? (
          <p className="text-sm text-muted-foreground">
            {m.thread_inspection_issues_omitted({ count: projection.issueTotal - projection.issues.length })}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{m.thread_inspection_admission()}</p>
      </section>
    </div>
  );
}

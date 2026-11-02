import type { Release } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import type { FactDraft } from './subject-facts';
import { presentStatementViolations, type StatementFeedback } from './statement-validation-presentation';

export function factStatementFeedback(
  draft: FactDraft,
  release: Release,
  locale: string,
  id: string,
): StatementFeedback | undefined {
  const result = draft.result;
  if (!draft.submission || !result || result.ok || result.reason !== 'invalid') return;
  const statement = draft.submission.statement;
  const itemValue = release.properties[statement.property.id]?.datatype === 'wikibase-item';
  const uneditable = m.correction_error_uneditable({}, { locale: locale as never });
  const valueGuidance = m.correction_error_value({}, { locale: locale as never });
  return {
    id,
    errors: presentStatementViolations(result.errors ?? [], statement, release, locale, id).map((error, index) =>
      itemValue && result.errors?.[index]?.pointer.startsWith('/statement/value')
        ? { ...error, instruction: error.instruction.replace(uneditable, valueGuidance) }
        : error,
    ),
  };
}

export function StatementViolationFeedback({
  feedback,
  locale,
}: {
  feedback: StatementFeedback | undefined;
  locale: string;
}) {
  if (!feedback?.errors.length) return null;
  const o = { locale: locale as never };
  return (
    <ul className="list-disc space-y-2 ps-5 text-sm" aria-label={m.correction_errors({}, o)}>
      {feedback.errors.map((error) => (
        <li key={error.id} id={error.id}>
          <a
            className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            href={`#${error.target}`}
            onClick={(event) => {
              event.preventDefault();
              const target = event.currentTarget.ownerDocument.getElementById(error.target);
              target?.focus();
              target?.scrollIntoView?.({ block: 'center' });
            }}
          >
            {error.label}
          </a>
          <p>{error.instruction}</p>
        </li>
      ))}
    </ul>
  );
}

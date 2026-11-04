import type { ReactNode } from 'react';
import { m } from '../../../paraglide/messages.js';

/** Inspect only the currently disclosed assertion already supplied by the native page. */
export function LiteraryAssertionInspection({
  locale,
  holder,
  candidate,
  property,
  statement,
}: {
  locale: string;
  holder: ReactNode;
  candidate: ReactNode;
  property: ReactNode;
  statement: string;
}) {
  const o = { locale: locale as never };
  return (
    <details className="text-sm" data-slot="literary-assertion-inspection">
      <summary className="min-h-11 cursor-pointer py-2">{m.literary_visit_inspect({}, o)}</summary>
      <dl className="grid min-w-0 gap-x-3 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="font-medium">{m.literary_visit_holder({}, o)}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">{holder}</dd>
        <dt className="font-medium">{m.literary_visit_property({}, o)}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">{property}</dd>
        <dt className="font-medium">{m.literary_visit_candidate({}, o)}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">{candidate}</dd>
        <dt className="font-medium">{m.literary_visit_statement({}, o)}</dt>
        <dd className="min-w-0 break-all"><code>{statement}</code></dd>
      </dl>
    </details>
  );
}

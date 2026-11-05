import { m } from '../../paraglide/messages.js';
import { useSession } from '../../session/query';
import { subjectHref } from '../../subject/subject-href';

/** Insert-only join from a current selected fact. Relation, document and term editors keep their owners. */
export function StatementCorrectionLink({
  id,
  title,
  statement,
  property,
  datatype,
  locale,
}: {
  id: string;
  title: string;
  statement: string;
  property: string;
  datatype: string;
  locale: string;
}) {
  const { state } = useSession();
  if (
    state !== 'signed-in' ||
    !['string', 'external-id', 'url', 'monolingualtext', 'time', 'quantity'].includes(datatype) ||
    ['schema:name', 'schema:alternateName', 'schema:description'].includes(property)
  )
    return null;
  const href = subjectHref({ id, label: title }, locale).href;
  return (
    <a
      className="ms-2 inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
      href={`${href}/edit?${new URLSearchParams({ property, statement })}`}
    >
      {m.correction_title({}, { locale: locale as never })}
    </a>
  );
}

import { createFileRoute, notFound } from '@tanstack/react-router';
import { SourceConceptSession } from '../../features/catalogue/source-concept-explorer/session';
import { getLocale } from '../../paraglide/runtime.js';
import { locales } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function originatingClassification(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n?#]/.test(value) ||
    /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return;
  try {
    const target = new URL(value, 'https://rezics.invalid');
    const parts = target.pathname.split('/');
    if (
      target.origin !== 'https://rezics.invalid' ||
      target.search ||
      target.hash ||
      parts.length !== 6 ||
      !locales.includes(decodeURIComponent(parts[1] ?? '') as (typeof locales)[number]) ||
      parts[2] !== 'subjects' ||
      !subjectId.test(decodeURIComponent(parts[3] ?? '')) ||
      !parts[4] ||
      parts[5] !== 'graph'
    )
      return;
    return value;
  } catch {
    return;
  }
}

export const Route = createFileRoute('/subjects/$id_/$slug/concepts')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const role = search.role;
    const returnTo = search.returnTo;
    const pin = search.pin;
    if (role !== undefined && (typeof role !== 'string' || role.length > 128)) throw notFound();
    if (returnTo !== undefined && !originatingClassification(returnTo)) throw notFound();
    if (pin !== undefined && (typeof pin !== 'string' || pin.length > 128)) throw notFound();
    return {
      role: typeof role === 'string' ? role : undefined,
      returnTo: originatingClassification(returnTo),
      pinUnsupported: pin !== undefined,
    };
  },
  head: () => ({ meta: [{ title: m.concept_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: ConceptsRoute,
});

function ConceptsRoute() {
  const { id } = Route.useParams();
  const { role, returnTo, pinUnsupported } = Route.useSearch();
  return (
    <SourceConceptSession
      key={`${id}:${getLocale()}`}
      id={id}
      locale={getLocale()}
      role={role}
      returnTo={returnTo}
      pinUnsupported={pinUnsupported}
    />
  );
}

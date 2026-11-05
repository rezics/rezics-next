import { m } from '../../paraglide/messages.js';
import type { IdentifierVisitOrigin } from './identifier-current-visit';
import { ViewHeading } from '../pages/view-heading';

export function IdentifierOriginChoice({
  locale,
  origin,
  originHref,
  globalHref,
  onChooseGlobal,
}: {
  locale: string;
  origin: IdentifierVisitOrigin;
  originHref?: string | undefined;
  globalHref?: string | undefined;
  onChooseGlobal: () => void;
}) {
  const o = { locale: locale as never };
  const originMessage =
    origin.kind === 'unsupported'
      ? m.identifiers_origin_unsupported({}, o)
      : origin.state === 'changed'
        ? m.identifiers_origin_changed({}, o)
        : origin.state === 'missing'
          ? m.identifiers_origin_missing({}, o)
          : origin.state === 'refused'
            ? m.identifiers_origin_refused({}, o)
            : origin.state === 'unavailable'
              ? m.identifiers_origin_unavailable({}, o)
              : origin.realmTitle
                ? m.identifiers_origin_realm_named({ name: origin.realmTitle }, o)
                : m.identifiers_origin_realm({}, o);
  return (
    <section className="flex flex-col gap-4 p-6" data-slot="identifier-origin-choice">
      <ViewHeading label={m.identifiers_title({}, o)} headingClassName="font-sans" />
      <p role="status">{originMessage}</p>
      <p>{m.identifiers_global_only_notice({}, o)}</p>
      {originHref ? (
        <a className="min-h-11 underline underline-offset-4" href={originHref}>
          {m.identifiers_return_origin({}, o)}
        </a>
      ) : globalHref ? (
        <a className="min-h-11 underline underline-offset-4" href={globalHref}>
          {m.identifiers_open_global_subject({}, o)}
        </a>
      ) : null}
      <button type="button" className="min-h-11 self-start underline underline-offset-4" onClick={onChooseGlobal}>
        {m.identifiers_global_choice({}, o)}
      </button>
    </section>
  );
}

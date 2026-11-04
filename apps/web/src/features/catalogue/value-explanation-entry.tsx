import { m } from '../../paraglide/messages.js';
import { valueExplanationHref, type ValueAddress } from './value-explanation';
import { withSubjectVisitReturn } from '../pages/subject-visit-navigation';

export function ValueExplanationEntry(
  props: ValueAddress & { title: string; locale: string; returnTo?: string | undefined; label?: string | undefined },
) {
  const href = valueExplanationHref(props, props.locale);
  return (
    <a
      className="ms-3 inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
      href={props.returnTo ? withSubjectVisitReturn(href, props.returnTo, props.locale) : href}
    >
      {props.label ?? m.value_why({}, { locale: props.locale as never })}
    </a>
  );
}

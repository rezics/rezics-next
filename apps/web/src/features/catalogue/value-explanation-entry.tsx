import { m } from '../../paraglide/messages.js';
import { valueExplanationHref, type ValueAddress } from './value-explanation';

export function ValueExplanationEntry(props: ValueAddress & { title: string; locale: string }) {
  return (
    <a
      className="ms-3 inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
      href={valueExplanationHref(props, props.locale)}
    >
      {m.value_why({}, { locale: props.locale as never })}
    </a>
  );
}

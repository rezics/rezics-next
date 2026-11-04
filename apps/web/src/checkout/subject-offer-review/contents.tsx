import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { SubjectOfferReading } from './reading';

/** Local reading shortcuts share the owned inspection's focus pattern and allocate no navigation. */
export function OfferReadingContents({ reading, locale }: { reading: SubjectOfferReading; locale: Locale }) {
  function focus(part: string) {
    if (!reading.current()) return;
    const target = document.getElementById(`${reading.id}-${part}`);
    if (!target?.isConnected) return;
    // Opening the technical disclosure is a local reading action, not a content read.
    const disclosure = target.closest('details');
    if (disclosure) disclosure.open = true;
    target.focus();
  }
  return (
    <nav aria-label={m.subject_choice_contents({}, { locale })} className="flex flex-wrap gap-2 border-t pt-4">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('price')}
      >
        {m.subject_choice_jump_price({}, { locale })}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('terms')}
      >
        {m.subject_choice_jump_terms({}, { locale })}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('references')}
      >
        {m.subject_choice_jump_references({}, { locale })}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('next')}
      >
        {m.subject_choice_jump_next({}, { locale })}
      </Button>
    </nav>
  );
}

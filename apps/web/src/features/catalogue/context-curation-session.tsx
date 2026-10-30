import { CandidateReview } from '../../subject/candidate-review';
import type { CandidateSlot } from '../../subject/candidates';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { readSubjectContext, confirmSubjectContext } from './context-curation-actions';

export function ContextCurationSession({
  id,
  context,
  property,
  slot,
  locale,
}: {
  id: string;
  context: string;
  property?: string;
  slot?: CandidateSlot;
  locale: string;
}) {
  const { state } = useSession();
  if (state !== 'signed-in')
    return (
      <p>
        {state === 'signed-out'
          ? m.relation_sign_in({}, { locale: locale as never })
          : m.candidate_loading({}, { locale: locale as never })}
      </p>
    );
  return (
    <CandidateReview
      id={id}
      locale={locale}
      context={context}
      initialProperty={property}
      slot={slot}
      transport={{
        read: (property, cursor, session) =>
          readSubjectContext({ data: { id, context, property, slot, cursor, session }, headers: csrfHeaders() }),
        confirm: (command) => confirmSubjectContext({ data: command, headers: csrfHeaders() }),
      }}
    />
  );
}

import { candidateSession } from '../../subject/candidate-lifetime';
import { EditorialContextSession } from './editorial-context-session';
import { CandidateReview } from '../../subject/candidate-review';
import type { CandidateSlot } from '../../subject/candidates';
import { csrfHeaders } from '../../threads/composer';
import { readSubjectContext, confirmSubjectContext } from './context-curation-actions';

function ContextCurationSessionLive({
  id,
  context,
  property,
  slot,
  locale,
  createHref,
}: {
  id: string;
  context: string;
  property?: string | undefined;
  slot?: CandidateSlot | undefined;
  locale: string;
  createHref?: string;
}) {
  return (
    <EditorialContextSession id={context} locale={locale} {...(createHref ? { createHref } : {})}>
      {() => (
        <CandidateReview
          id={id}
          locale={locale}
          context={context}
          initialProperty={property}
          slot={slot}
          transport={{
            read: (property, cursor, session, work) =>
              !work?.live()
                ? Promise.resolve({ ok: false, reason: 'denied' })
                : readSubjectContext({
                    data: { id, context, property, slot, cursor, session, expectedReader: work.reader },
                    headers: csrfHeaders(),
                  }),
            confirm: (command, work) =>
              !work?.live()
                ? Promise.resolve({ ok: false, reason: 'denied' })
                : confirmSubjectContext({ data: command, headers: csrfHeaders() }),
          }}
        />
      )}
    </EditorialContextSession>
  );
}

export const ContextCurationSession = candidateSession(ContextCurationSessionLive);

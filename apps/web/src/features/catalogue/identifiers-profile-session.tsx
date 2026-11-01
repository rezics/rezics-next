import { candidateSession } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { IdentifiersProfile, type IdentifiersProfileProps } from './identifiers-profile-view';

function IdentifiersProfileSessionLive({
  id,
  locale,
  initialReview,
}: Pick<IdentifiersProfileProps, 'id' | 'locale' | 'initialReview'>) {
  const { state } = useSession();
  return (
    <IdentifiersProfile
      key={`${id}:${locale}`}
      id={id}
      locale={locale}
      session={state}
      initialReview={initialReview}
      transport={{
        read: () => readCorrection({ data: { id }, headers: csrfHeaders() }),
        propose: (data) => submitFactCorrection({ data, headers: csrfHeaders() }),
      }}
      review={(_property, initialSession) => {
        return {
          read: async (property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await readSubjectCandidates({
              data: { expectedReader: work.reader, id, property, cursor, session },
              headers: csrfHeaders(),
            });
            return result;
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await confirmSubjectCandidate({ data: command, headers: csrfHeaders() });
            return result;
          },
        };
      }}
    />
  );
}

export const IdentifiersProfileSession = candidateSession(IdentifiersProfileSessionLive);

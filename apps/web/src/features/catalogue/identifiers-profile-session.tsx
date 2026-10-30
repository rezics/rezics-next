import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readCorrection } from './statement-editor-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { IdentifiersProfile, type IdentifiersProfileProps } from './identifiers-profile-view';

export function IdentifiersProfileSession({
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
        let session = initialSession;
        return {
          read: async (property, cursor) => {
            const result = await readSubjectCandidates({
              data: { id, property, cursor, session },
              headers: csrfHeaders(),
            });
            if (result.ok) session = result.session ?? session;
            return result;
          },
          confirm: async (command) => {
            const result = await confirmSubjectCandidate({ data: { ...command, session }, headers: csrfHeaders() });
            if (result.ok) session = result.session ?? session;
            return result;
          },
        };
      }}
    />
  );
}

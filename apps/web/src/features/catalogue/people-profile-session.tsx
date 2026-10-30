import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { RelationEditorSession } from './relation-editor-session';
import { loadPeopleProfile, createCataloguePeopleProfile } from './people-profile-actions';
import { PeopleProfileEditor } from './people-profile-view';
import type { PeopleAddress } from './people-profile';

export function PeopleProfileSession({ id, work, locale }: PeopleAddress & { locale: string }) {
  const { state } = useSession();
  return <PeopleProfileEditor {...(id ? { id } : {})} {...(work !== undefined ? { work } : {})} locale={locale} session={state}
    transport={{
      load: () => loadPeopleProfile({ data: { ...(id ? { id } : {}), ...(work !== undefined ? { work } : {}) } }),
      create: (data) => createCataloguePeopleProfile({ data, headers: csrfHeaders() }),
      read: (data) => readCreatedCatalogueSubject({ data }),
    }}
    propose={(data) => submitFactCorrection({ data, headers: csrfHeaders() })}
    review={(_property, initialSession) => {
      let session = initialSession;
      return {
        read: async (property, cursor) => {
          const result = await readSubjectCandidates({ data: { id: id!, property, cursor, session }, headers: csrfHeaders() });
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
    relations={id ? <RelationEditorSession id={id} locale={locale} /> : undefined}
    onNavigate={(href) => window.location.assign(href)}
  />;
}

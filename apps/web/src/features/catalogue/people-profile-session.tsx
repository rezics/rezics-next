import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import { submitFactCorrection } from './subject-facts-actions';
import { RelationEditorSession } from './relation-editor-session';
import { relationTargetSearch } from './relation-editor-search';
import { loadPeopleProfile, createCataloguePeopleProfile } from './people-profile-actions';
import { PeopleProfileEditor } from './people-profile-view';
import type { PeopleAddress } from './people-profile';

function PeopleProfileSessionLive({
  id,
  work,
  locale,
  creditHandoffToken,
}: PeopleAddress & { locale: string; creditHandoffToken?: string }) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  return (
    <PeopleProfileEditor
      {...(id ? { id } : {})}
      {...(work !== undefined ? { work } : {})}
      {...(creditHandoffToken ? { creditHandoffToken } : {})}
      handoffReader={editorWork.reader}
      handoffReaderLive={editorWork.live}
      locale={locale}
      session={state}
      transport={{
        load: () => loadPeopleProfile({ data: { ...(id ? { id } : {}), ...(work !== undefined ? { work } : {}) } }),
        create: (data) =>
          createCataloguePeopleProfile({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        read: (data) => readCreatedCatalogueSubject({ data }),
      }}
      propose={(data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() })}
      review={(_property, initialSession) => {
        return {
          read: async (property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            const result = await readSubjectCandidates({
              data: { expectedReader: work.reader, id: id!, property, cursor, session },
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
      search={search}
      relations={id ? <RelationEditorSession id={id} locale={locale} /> : undefined}
      onNavigate={(href) => window.location.assign(href)}
    />
  );
}

export const PeopleProfileSession = candidateSession(PeopleProfileSessionLive);

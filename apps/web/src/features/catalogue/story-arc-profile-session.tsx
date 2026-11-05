import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { candidateSession } from '../../subject/candidate-lifetime';
import { useCallback } from 'react';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { StoryArcProfile, StoryArcProfileContextNotice } from './story-arc-profile-view';
import type { StoryArcAddress } from './story-arc-profile';
import { storyArcEntry } from './story-arc-profile-entry';
import { storyArcClassificationCurrent } from './story-arc-classification-review';
import { loadStoryArcProfile } from './story-arc-profile-actions';
import {
  readCatalogueCreateEligibility,
  readCreateDefinitions,
  createCatalogueSubject,
  readCreatedCatalogueSubject,
} from './create-subject-actions';
import { relationTargetSearch } from './relation-editor-search';
import { submitFactCorrection } from './subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../pages/curate-actions';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';

function StoryArcProfileSessionLive({
  locale,
  realm,
  context,
  definition,
  via,
  address,
  globalChoiceHref,
  classificationHandoffToken,
  id,
  work,
}: StoryArcAddress & {
  locale: string;
  realm?: string | undefined;
  context?: string | undefined;
  definition?: string | undefined;
  via?: string | undefined;
  address?: string | undefined;
  globalChoiceHref?: string | undefined;
  classificationHandoffToken?: string;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  // Observed intent is not a native binding. Refuse before the Global-only profile and its writers mount.
  if (realm || (context !== undefined && context !== PAGE_GLOBAL_CONTEXT))
    return (
      <StoryArcProfileContextNotice
        locale={locale}
        {...(via ? { via } : {})}
        globalChoiceHref={globalChoiceHref ?? storyArcEntry({ locale }).href}
      />
    );
  return (
    <StoryArcProfile
      id={id}
      work={work}
      context={context}
      realm={realm}
      definition={definition}
      via={via}
      address={address}
      locale={locale}
      session={state}
      search={search}
      transport={{
        load: (data) => loadStoryArcProfile({ data }),
        creation: {
          definitions: (data) => readCreateDefinitions({ data }),
          eligibility: () => readCatalogueCreateEligibility(),
          submit: (data) => createCatalogueSubject({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          read: (data) => readCreatedCatalogueSubject({ data }),
        },
      }}
      facts={(id) => ({
        read: async () => storyArcClassificationCurrent(await loadStoryArcProfile({ data: { id } })),
        propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      })}
      review={(id, _property, initialSession) => {
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
      {...(classificationHandoffToken ? { classificationHandoffToken } : {})}
      handoffReader={editorWork.reader}
      handoffReaderLive={editorWork.live}
      relations={(id) => ({
        read: (slot, cursor, session) =>
          readSubjectRelationEditor({
            data: editorRequest({ id, slot, cursor, session }, editorWork),
            headers: csrfHeaders(),
          }),
        propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      })}
    />
  );
}

export const StoryArcProfileSession = candidateSession(StoryArcProfileSessionLive);

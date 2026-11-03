import { candidateSession } from '../../subject/candidate-lifetime';
import { editorRequest } from './editor-request';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { RelationEditor } from './relation-editor';
import { relationTargetSearch } from './relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from './relation-editor-actions';
import { claimCreditTargetReturn, discardCreditTargetHandoff, type CreditTargetHandoff } from './credit-target-handoff';
import {
  claimRelatedWorkReturn,
  discardRelatedWorkHandoff,
  type RelatedWorkHandoff,
} from './related-work-handoff';

export const RelationEditorSession = candidateSession(RelationEditorSessionLive);

function RelationEditorSessionLive({
  id,
  locale,
  creditHandoffToken,
  relatedWorkHandoffToken,
}: {
  id: string;
  locale: string;
  creditHandoffToken?: string;
  relatedWorkHandoffToken?: string;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const router = useRouter();
  const [creditHandoff, setCreditHandoff] = useState<CreditTargetHandoff>();
  const [relatedWorkHandoff, setRelatedWorkHandoff] = useState<RelatedWorkHandoff>();
  const activeHandoff = useRef<string | undefined>(undefined);
  const activeRelatedWork = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!creditHandoffToken) {
      setCreditHandoff(undefined);
      return;
    }
    const handoff = editorWork.live() ? claimCreditTargetReturn(creditHandoffToken, id, editorWork.reader) : undefined;
    if (!handoff) {
      discardCreditTargetHandoff(creditHandoffToken);
      setCreditHandoff(undefined);
      return;
    }
    activeHandoff.current = handoff.token;
    setCreditHandoff(handoff);
    return () => {
      if (activeHandoff.current === handoff.token) {
        activeHandoff.current = undefined;
        discardCreditTargetHandoff(handoff.token);
      }
    };
  }, [creditHandoffToken, editorWork, id]);
  useEffect(() => {
    if (!relatedWorkHandoffToken) {
      setRelatedWorkHandoff(undefined);
      return;
    }
    const handoff = editorWork.live()
      ? claimRelatedWorkReturn(relatedWorkHandoffToken, id, editorWork.reader)
      : undefined;
    if (!handoff) {
      discardRelatedWorkHandoff(relatedWorkHandoffToken);
      setRelatedWorkHandoff(undefined);
      return;
    }
    activeRelatedWork.current = handoff.token;
    setRelatedWorkHandoff(handoff);
    return () => {
      if (activeRelatedWork.current === handoff.token) {
        activeRelatedWork.current = undefined;
        discardRelatedWorkHandoff(handoff.token);
      }
    };
  }, [relatedWorkHandoffToken, editorWork, id]);
  const consumeHandoff = useCallback((token: string) => {
    if (activeHandoff.current === token) activeHandoff.current = undefined;
    setCreditHandoff(undefined);
  }, []);
  const consumeRelatedWork = useCallback((token: string) => {
    if (activeRelatedWork.current === token) activeRelatedWork.current = undefined;
    setRelatedWorkHandoff(undefined);
  }, []);
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (state !== 'signed-in') return <p>{state === 'signed-out' ? m.relation_sign_in() : m.candidate_loading()}</p>;
  return (
    <RelationEditor
      id={id}
      locale={locale}
      handoffReader={editorWork.reader}
      handoffReaderLive={editorWork.live}
      {...(creditHandoff ? { creditTargetHandoff: creditHandoff } : {})}
      {...(relatedWorkHandoff ? { relatedWorkHandoff } : {})}
      onCreditTargetHandoffConsumed={consumeHandoff}
      onRelatedWorkHandoffConsumed={consumeRelatedWork}
      search={search}
      onSelected={() => router.invalidate()}
      transport={{
        read: (slot, cursor, session) =>
          readSubjectRelationEditor({
            data: editorRequest({ id, slot, cursor, session }, editorWork),
            headers: csrfHeaders(),
          }),
        propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
      }}
    />
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { GameInitialFactRemove, GameStatementFields } from './game-profile-fields';
import { InitialFieldChoice } from './initial-field-choice';
import { ReferenceReusePanel } from './reference-reuse-view';
import { PartValue, type StatementFieldsRead } from './statement-editor-view';
import { emptyCreationStatement, type StatementInput } from './statement-editor';
import {
  applyMusicContextCreateReuse,
  captureMusicContextCreateReuse,
  musicContextCreateFactDrafts,
  musicContextCreateFields,
  musicContextCreateHolder,
  refreshMusicContextCreateReuse,
  type MusicContextCreateFact,
  type MusicContextCreateReuse,
} from './music-context-create';
import { musicContextKind } from './music-context-profile';
import { typeExtends } from '../pages/graph-browser';
import { reuseIsStale } from './reference-reuse';
import { MusicContextStatementSummary } from './music-context-create-review';

const actionClass =
  'h-auto min-h-8 min-w-8 max-w-full whitespace-normal break-words py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:639px)_and_(pointer:coarse)]:min-w-11';
const selectClass =
  'w-fit min-w-0 max-w-full [&>select]:max-w-full [@media(max-width:639px)_and_(pointer:coarse)]:w-full [@media(max-width:639px)_and_(pointer:coarse)]:[&>select]:min-h-11';

export function MusicContextCreateFields({
  type,
  release,
  locale,
  search,
  facts,
  disabled,
  canEdit,
  change,
  invalidate,
  discardTypeDraft,
}: {
  type: string;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  facts: MusicContextCreateFact[];
  disabled: boolean;
  canEdit: () => boolean;
  change: (next: MusicContextCreateFact[]) => void;
  invalidate: () => void;
  discardTypeDraft: () => void;
}) {
  const o = { locale: locale as never };
  const id = 'music-context-initial-facts';
  const kind = musicContextKind(release, type);
  const typeAdmitted = kind !== 'unsupported';
  const admitted = useMemo(() => musicContextCreateFields(release, type), [release, type]);
  const context: StatementFieldsRead = { release, source: null, public: { subject: { type }, related: {} } };
  const rowsRef = useRef({ type, release, facts, change, disabled, canEdit });
  rowsRef.current = { type, release, facts, change, disabled, canEdit };
  const [reuse, setReuse] = useState<MusicContextCreateReuse | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ key: string; index: number; nonce: number }>();
  const [discarding, setDiscarding] = useState(false);
  const focusNonce = useRef(0);
  useEffect(() => setDiscarding(false), [type]);
  const editable = (row?: MusicContextCreateFact) =>
    rowsRef.current.type === type &&
    rowsRef.current.release === release &&
    !rowsRef.current.disabled &&
    rowsRef.current.canEdit() &&
    typeAdmitted &&
    (!row || rowsRef.current.facts.includes(row));
  const publish = (next: MusicContextCreateFact[]) => {
    if (!editable()) return;
    rowsRef.current.facts = next;
    rowsRef.current.change(next);
    setReuse((current) =>
      current && !next.some((row) => musicContextCreateHolder(row.key) === current.source.holder) ? null : current,
    );
    invalidate();
  };
  const addition = useRef({ type, release, editable });
  addition.current = { type, release, editable };
  const reuseDrafts = musicContextCreateFactDrafts(facts, release, type);
  if (!type) return null;
  return (
    <section id={id} className="min-w-0 max-w-full space-y-5 py-3 [overflow-wrap:anywhere] sm:py-4">
      <ContentItemHeading level={2} className="font-sans text-lg font-semibold">
        {m.music_context_create_facts({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.music_context_create_optional({}, o)}</p>
      {!typeAdmitted && (
        <p role="status" className="text-sm">
          {m.music_context_create_type_unavailable({}, o)}
        </p>
      )}
      {typeAdmitted && admitted.length > 0 && (
        <InitialFieldChoice
          groups={[{ properties: admitted }]}
          release={release}
          occupied={facts.map((row) => row.statement.property.id)}
          locale={locale}
          disabled={disabled || !canEdit()}
          addLabel={m.music_context_create_add_fact({}, o)}
          fieldClassName="min-w-0 max-w-full"
          labelClassName="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
          selectClassName={selectClass}
          buttonClassName={actionClass}
          add={(property) => {
            if (!editable()) return false;
            const key = crypto.randomUUID();
            publish([...rowsRef.current.facts, { key, statement: emptyCreationStatement(property, release) }]);
            return {
              targetId: musicContextCreateHolder(key),
              current: () =>
                addition.current.type === type &&
                addition.current.release === release &&
                addition.current.editable() &&
                rowsRef.current.facts.some((row) => row.key === key),
            };
          }}
        />
      )}
      {typeAdmitted && admitted.length === 0 && <p role="status">{m.music_context_create_no_fields({}, o)}</p>}
      {facts.map((row) => {
        const property = row.statement.property.id;
        const definition = release.properties[property];
        const propertyAdmitted = typeAdmitted && admitted.includes(property);
        const name = pickText(definition?.labels ?? {}, locale);
        const holderId = musicContextCreateHolder(row.key);
        return (
          <section key={row.key} className="min-w-0 max-w-full">
            <ContentItemFrame
              as="div"
              data-slot="music-context-initial-fact"
              className="min-w-0 space-y-4 p-4 [overflow-wrap:anywhere]"
            >
              <ContentItemHeading
                level={3}
                className="min-w-0 max-w-full whitespace-normal break-words font-sans text-base font-semibold"
                lang={name.lang ?? undefined}
              >
                {name.text || m.candidate_value_unavailable({}, o)}
              </ContentItemHeading>
              {!propertyAdmitted ? (
                <div id={`${holderId}-fact`} className="min-w-0 space-y-3">
                  <p role="status" className="text-sm text-muted-foreground">
                    {definition
                      ? m.music_context_create_review_unsupported({}, o)
                      : m.music_context_create_review_unaddressable({}, o)}
                  </p>
                  <MusicContextStatementSummary statement={row.statement} read={context} locale={locale} />
                </div>
              ) : (
                <fieldset disabled={disabled || !canEdit()} className="min-w-0">
                  <GameStatementFields
                    id={holderId}
                    statement={row.statement}
                    context={context}
                    locale={locale}
                    search={search}
                    editAllowed={() => editable(row)}
                    change={(statement: StatementInput) => {
                      if (!editable(row)) return;
                      publish(rowsRef.current.facts.map((entry) => (entry === row ? { ...entry, statement } : entry)));
                    }}
                    stablePartAddresses
                    localDraft
                    targetAdmitted={(property, target) =>
                      (release.properties[property]?.targets ?? []).some((base) => typeExtends(release, target, base))
                    }
                    reuse={
                      editable(row) && facts.length > 1
                        ? {
                            onReuse: (index) => {
                              if (!editable(row)) return;
                              const next = captureMusicContextCreateReuse(facts, row.key, index, release, type);
                              if (next) setReuse(next);
                            },
                          }
                        : undefined
                    }
                    focusReference={
                      focusCopy?.key === row.key ? { index: focusCopy.index, nonce: focusCopy.nonce } : undefined
                    }
                  />
                </fieldset>
              )}
              <GameInitialFactRemove
                row={row}
                disabled={disabled || !typeAdmitted}
                locale={locale}
                onRemove={() => {
                  if (!disabled) publish(rowsRef.current.facts.filter((entry) => entry !== row));
                }}
              />
            </ContentItemFrame>
          </section>
        );
      })}
      {reuse && typeAdmitted && (
        <ReferenceReusePanel
          source={reuse.source}
          drafts={reuseDrafts}
          selected={reuse.selected}
          read={{ release, public: { related: {} } }}
          locale={locale}
          capture={reuse.capture}
          applied={reuse.applied}
          refused={reuse.refused}
          onSelected={(selected) => setReuse({ ...reuse, selected, applied: [], refused: [] })}
          onApply={() => {
            if (!editable() || reuseIsStale(reuse.source, reuseDrafts, reuse.selected, reuse.capture)) return;
            const result = applyMusicContextCreateReuse(rowsRef.current.facts, reuse, release, type);
            rowsRef.current.facts = result.facts;
            rowsRef.current.change(result.facts);
            setReuse(result.reuse);
            const first = result.reuse.applied[0];
            if (first) {
              const row = result.facts.find((item) => musicContextCreateHolder(item.key) === first.holder);
              if (row) setFocusCopy({ key: row.key, index: first.index, nonce: ++focusNonce.current });
            }
            invalidate();
          }}
          onCancel={() => setReuse(null)}
          onRefresh={() => {
            const next = refreshMusicContextCreateReuse(rowsRef.current.facts, reuse, release, type);
            if (next) setReuse(next);
          }}
          onOpen={(holder, index) => {
            const row = rowsRef.current.facts.find((item) => musicContextCreateHolder(item.key) === holder);
            if (row) setFocusCopy({ key: row.key, index, nonce: ++focusNonce.current });
          }}
        />
      )}
      {!typeAdmitted && (
        <div className="space-y-2">
          {discarding ? (
            <div role="group" aria-label={m.music_context_create_discard_question({}, o)} className="space-y-2">
              <p>{m.music_context_create_discard_question({}, o)}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className={actionClass} onClick={() => setDiscarding(false)}>
                  {m.candidate_cancel({}, o)}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className={actionClass}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    discardTypeDraft();
                    setDiscarding(false);
                  }}
                >
                  {m.music_context_create_discard_draft({}, o)}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              disabled={disabled}
              onClick={() => setDiscarding(true)}
            >
              {m.music_context_create_discard_draft({}, o)}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

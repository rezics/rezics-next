import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Release } from '@rezics/definitions';
import { releaseDigest } from '@rezics/definitions';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { definitionText } from './definition-guide';
import { EditorFailure, PartValue, StatementFields, type StatementFieldsRead } from './statement-editor-view';
import { presentStatementViolations } from './statement-validation-presentation';
import { creationStatement, emptyCreationStatement, type StatementInput } from './statement-editor';
import { ReferenceReusePanel } from './reference-reuse-view';
import { applyReuse, captureReuse, cloneReferenceGroup, type ReuseCapture, type ReuseRefusal, type ReuseSource } from './reference-reuse';
import type { FactDraft } from './subject-facts';
import type { Violation } from '@rezics/definitions/validate';
import {
  storyArcCreateProperties,
  storyArcCreatePropertyAdmitted,
  storyArcCreateRowErrors,
  type StoryArcFactDraft,
  type StoryArcFactStore,
  type StoryArcPreparedIdentity,
} from './story-arc-create-model';
import { storyArcType } from './story-arc-profile';

const action =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

type ReuseState = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};

function factDrafts(rows: readonly StoryArcFactDraft[]): FactDraft[] {
  return rows.map((row) => ({
    holder: row.id,
    property: row.property,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
}

export function StoryArcCreateFields({
  release,
  locale,
  disabled,
  canEdit,
  store,
  errors,
  identity,
  invalidate,
}: {
  release: Release;
  locale: string;
  disabled: boolean;
  canEdit: () => boolean;
  store: StoryArcFactStore;
  errors: readonly Pick<Violation, 'pointer' | 'code'>[];
  identity?: StoryArcPreparedIdentity;
  invalidate?: () => void;
}) {
  const o = { locale: locale as never };
  const rows = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const context: StatementFieldsRead = { release, source: null, public: { related: {}, subject: { type: storyArcType } } };
  const properties = storyArcCreateProperties(release);
  const [property, setProperty] = useState('');
  const [reuse, setReuse] = useState<ReuseState | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number }>();
  const previousRelease = useRef<string>();
  const digest = releaseDigest(release);

  useEffect(() => {
    if (previousRelease.current && previousRelease.current !== digest) invalidate?.();
    previousRelease.current = digest;
  }, [digest, invalidate]);

  const options = properties.filter((id) => release.properties[id]?.multivalued || !rows.some((row) => row.property === id));
  const selectedName = definitionText(release.properties[property]?.labels, locale).text || property;
  const drafts = factDrafts(rows);
  const factsRead = { release, public: { related: {} } };
  const available = (id: string) => options.includes(id) && storyArcCreatePropertyAdmitted(release, id);

  function add() {
    if (!canEdit() || !available(property)) return;
    const statement = emptyCreationStatement(property, release);
    store.update([...store.getSnapshot(), { id: store.addId(), property, statement }]);
    setProperty(options.find((id) => id !== property) ?? '');
    invalidate?.();
  }

  function change(id: string, statement: StatementInput) {
    if (!canEdit()) return;
    store.update(store.getSnapshot().map((row) => (row.id === id ? { ...row, statement } : row)));
    invalidate?.();
  }

  function remove(id: string) {
    if (!canEdit()) return;
    store.update(store.getSnapshot().filter((row) => row.id !== id));
    invalidate?.();
  }

  function move(id: string, offset: -1 | 1) {
    if (!canEdit()) return;
    const current = store.getSnapshot();
    const index = current.findIndex((row) => row.id === id);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= current.length) return;
    const ordered = [...current];
    [ordered[index], ordered[next]] = [ordered[next]!, ordered[index]!];
    store.update(ordered);
    invalidate?.();
  }

  function openReuse(row: StoryArcFactDraft, groupIndex: number) {
    if (!canEdit()) return;
    const group = row.statement.references[groupIndex];
    if (!group) return;
    const source = {
      holder: row.id,
      property: row.property,
      groupIndex,
      snapshot: cloneReferenceGroup(group),
    };
    setReuse({ source, selected: [], capture: captureReuse(source, drafts), applied: [], refused: [] });
  }

  function applySelected() {
    if (!reuse || !canEdit()) return;
    const result = applyReuse(drafts, reuse.source, reuse.selected, release);
    const updates = new Map(result.drafts.map((draft) => [draft.holder, draft.statement]));
    store.update(
      store.getSnapshot().map((row) => {
        const statement = updates.get(row.id);
        return statement ? { ...row, statement } : row;
      }),
    );
    setReuse({ ...reuse, applied: result.applied, refused: result.refused });
    const first = result.applied[0];
    if (first) setFocusCopy({ holder: first.holder, index: first.index, nonce: Date.now() });
    invalidate?.();
  }

  function refreshReuse() {
    if (!reuse) return;
    const origin = store.getSnapshot().find((row) => row.id === reuse.source.holder);
    const group = origin?.statement.references[reuse.source.groupIndex];
    if (!origin || !group) return;
    const source = { ...reuse.source, snapshot: cloneReferenceGroup(group) };
    setReuse({ ...reuse, source, capture: captureReuse(source, factDrafts(store.getSnapshot())), applied: [], refused: [] });
  }

  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-labelledby="story-arc-initial-evidence-title">
      <h2 id="story-arc-initial-evidence-title" className="text-xl font-semibold">
        {m.story_arc_create_initial_facts({}, o)}
      </h2>
      <p className="text-sm text-muted-foreground">{m.story_arc_create_initial_facts_help({}, o)}</p>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1">
          <span>{m.story_arc_create_property({}, o)}</span>
          <select
            className="h-11 w-full rounded-md border border-input bg-background px-3 md:pointer-fine:h-8"
            aria-label={m.story_arc_create_property({}, o)}
            value={property}
            disabled={disabled || !canEdit() || options.length === 0}
            onChange={(event) => setProperty(event.target.value)}
          >
            <option value="">{m.story_arc_create_choose_property({}, o)}</option>
            {options.map((id) => (
              <option key={id} value={id}>
                {definitionText(release.properties[id]?.labels, locale).text || id}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" className={action} disabled={disabled || !canEdit() || !available(property)} onClick={add}>
          {m.people_profile_add_fact({ field: selectedName }, o)}
        </Button>
      </div>

      {rows.map((row, index) => {
        const name = definitionText(release.properties[row.property]?.labels, locale).text || row.property;
        const supported = storyArcCreatePropertyAdmitted(release, row.property);
        const violations = storyArcCreateRowErrors(errors, row, identity);
        const feedback = { id: row.id, errors: presentStatementViolations(violations, row.statement, release, locale, row.id) };
        return (
          <fieldset
            key={row.id}
            id={row.id}
            disabled={disabled || !canEdit()}
            className="min-w-0 space-y-3 rounded-xl border border-border p-3 sm:p-4"
          >
            <legend className="max-w-full px-1 font-semibold [overflow-wrap:anywhere]">{name}</legend>
            {!supported ? (
              <div className="space-y-2" role="status">
                <EditorFailure reason="stale" locale={locale} />
                <PartValue part={row.statement} read={context} locale={locale} />
              </div>
            ) : (
              <StatementFields
                creation
                localDraft
                stablePartAddresses
                draft={row.statement}
                current={context}
                locale={locale}
                feedback={feedback}
                heading="h4"
                guideReturn={`/${locale}/catalogue/story-arc`}
                change={(next) => change(row.id, next)}
                reuse={
                  canEdit() && rows.length > 1
                    ? { disabled: disabled || !supported, onReuse: (group) => openReuse(row, group) }
                    : undefined
                }
                focusReference={focusCopy?.holder === row.id ? focusCopy : undefined}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className={action} disabled={disabled || !canEdit() || index === 0} onClick={() => move(row.id, -1)}>
                {m.story_arc_create_move_up({}, o)}
              </Button>
              <Button type="button" variant="outline" className={action} disabled={disabled || !canEdit() || index === rows.length - 1} onClick={() => move(row.id, 1)}>
                {m.story_arc_create_move_down({}, o)}
              </Button>
              <Button type="button" variant="ghost" className={action} disabled={disabled || !canEdit()} onClick={() => remove(row.id)}>
                {m.people_profile_remove_fact({}, o)}
              </Button>
            </div>
          </fieldset>
        );
      })}

      {reuse && (
        <ReferenceReusePanel
          source={reuse.source}
          drafts={drafts}
          selected={reuse.selected}
          read={factsRead}
          locale={locale}
          capture={reuse.capture}
          applied={reuse.applied}
          refused={reuse.refused}
          onSelected={(selected) => setReuse({ ...reuse, selected, applied: [], refused: [] })}
          onApply={applySelected}
          onCancel={() => setReuse(null)}
          onRefresh={refreshReuse}
          onOpen={(holder, groupIndex) => setFocusCopy({ holder, index: groupIndex, nonce: Date.now() })}
        />
      )}
    </section>
  );
}

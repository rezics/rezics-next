import { useEffect, useRef, useState } from 'react';
import type { SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import { pageText } from '../pages/data';
import { EditorFailure, PartValue, type StatementFieldsRead } from './statement-editor-view';
import { GameInitialFactRemove, GameStatementFields } from './game-profile-fields';
import { addonBase, addonFields, addonTarget, addonType, type AddonRead } from './addon-profile';
import type { StatementInput } from './statement-editor';

export type AddonBaseDraft = { key: string; statement: StatementInput };
type AddonReady = Extract<AddonRead, { ok: true }>;

function exactPickerSubject(subject: SubjectRead, release: Release, locale: string): EntityPickerSubject {
  const type = subject.subject.type;
  return {
    id: subject.subject.id,
    title: pageText(subject.subject.labels, locale).text || subject.subject.id,
    types: [type],
    typeLabel: pageText(release.types[type]?.labels, locale).text || type,
    year: null,
    cover: null,
  };
}

function baseStatement(target: string): StatementInput {
  return {
    property: { id: addonBase },
    value: { type: 'value', content: target },
    qualifiers: [],
    references: [],
    rank: 'normal',
  };
}

/** A route work is a preview only; the picker stages a base after an exact current read. */
export function AddonBaseWorkspace({
  read,
  locale,
  search,
  load,
  disabled,
  draft,
  change,
  releaseChanged,
  checkingChanged,
}: {
  read: AddonReady;
  locale: string;
  search: EntityPickerSearch;
  load: (address: { work?: string | undefined }) => Promise<AddonRead>;
  disabled: boolean;
  draft?: AddonBaseDraft | undefined;
  change: (draft: AddonBaseDraft | undefined) => void;
  releaseChanged: (release: Release) => void;
  checkingChanged: (checking: boolean) => void;
}) {
  const options = { locale: locale as never };
  const [picked, setPicked] = useState<EntityPickerSubject>();
  const [checked, setChecked] = useState<SubjectRead>();
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<Extract<AddonRead, { ok: false }>['reason']>();
  const request = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    if (!draft) {
      setPicked(undefined);
      setChecked(undefined);
      setFailure(undefined);
    }
  }, [draft]);

  const target =
    draft?.statement.value.type === 'value' && typeof draft.statement.value.content === 'string'
      ? draft.statement.value.content
      : '';
  const exact = checked?.subject.id === target ? checked : read.work?.subject.id === target ? read.work : undefined;
  const pickerValue = target
    ? [
        picked?.id === target
          ? picked
          : exact
            ? exactPickerSubject(exact, read.release, locale)
            : {
                id: target,
                title: target,
                types: [],
                typeLabel: '',
                cover: null,
              },
      ]
    : [];
  const admitted = addonFields(read.release).includes(addonBase);
  const canEdit = !disabled && !checking;
  const canChoose = canEdit && admitted;
  const context = {
    release: read.release,
    source: null,
    public: { subject: { type: addonType }, related: {} },
  } satisfies StatementFieldsRead;

  async function choose(items: EntityPickerSubject[]) {
    if (!items[0]) {
      request.current++;
      setChecking(false);
      checkingChanged(false);
      setFailure(undefined);
      setPicked(undefined);
      setChecked(undefined);
      if (draft) change({ ...draft, statement: { ...draft.statement, value: { type: 'value', content: '' } } });
      return;
    }
    if (!canChoose) return;
    const item = items[0];
    const generation = ++request.current;
    setChecking(true);
    checkingChanged(true);
    setFailure(undefined);
    try {
      const current = await load({ work: item.id });
      if (!mounted.current || request.current !== generation) return;
      if (!current.ok) {
        setFailure(current.reason);
        return;
      }
      if (current.workIssue) {
        setFailure(current.workIssue);
        return;
      }
      if (
        !current.work ||
        current.work.subject.id !== item.id ||
        !addonFields(current.release).includes(addonBase) ||
        !addonTarget(current.release, addonBase, current.work.subject.type)
      ) {
        setFailure('invalid');
        return;
      }
      releaseChanged(current.release);
      setPicked(item);
      setChecked(current.work);
      setFailure(undefined);
      change({
        key: draft?.key ?? crypto.randomUUID(),
        statement: {
          ...(draft?.statement ?? baseStatement('')),
          property: { id: addonBase },
          value: { type: 'value', content: current.work.subject.id },
        },
      });
    } catch {
      if (mounted.current && request.current === generation) setFailure('unavailable');
    } finally {
      if (mounted.current && request.current === generation) {
        setChecking(false);
        checkingChanged(false);
      }
    }
  }

  return (
    <section className="min-w-0 space-y-4" aria-busy={checking}>
      <header className="space-y-2">
        <ContentItemHeading level={2} className="font-sans text-lg font-semibold">
          {m.addon_base_workspace_title({}, options)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.addon_base_workspace_intro({}, options)}</p>
      </header>
      {read.workId && (
        <ContentItemFrame as="div" className="min-w-0 space-y-2 rounded-xl bg-muted/30 p-4">
          <h3 className="font-semibold">{m.addon_base_context_title({}, options)}</h3>
          {read.work ? (
            <>
              <p>
                <a
                  className="underline underline-offset-4"
                  href={
                    subjectHref(
                      { id: read.work.subject.id, label: pageText(read.work.subject.labels, locale).text },
                      locale,
                    ).href
                  }
                >
                  {pageText(read.work.subject.labels, locale).text || m.subject_value_unlabelled({}, options)}
                </a>
              </p>
              <p>
                <code className="break-all text-xs">{read.work.subject.id}</code> · {read.work.subject.type}
              </p>
              {read.workIssue && <EditorFailure locale={locale} reason={read.workIssue} />}
            </>
          ) : (
            <>
              <p className="break-all text-sm">
                <code>{read.workId}</code>
              </p>
              <EditorFailure locale={locale} reason={read.workIssue ?? 'unavailable'} />
            </>
          )}
          <p className="text-sm">{m.addon_base_context_note({}, options)}</p>
        </ContentItemFrame>
      )}
      {!admitted && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.addon_base_withdrawn({}, options)}
        </p>
      )}
      <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
        <EntityPicker
          label={m.addon_base({}, options)}
          value={pickerValue}
          src={coverSrc}
          disabled={!canChoose}
          search={async (text, signal) =>
            (await search(text, signal)).filter((item) =>
              item.types.some((type) => addonTarget(read.release, addonBase, type)),
            )
          }
          onValueChange={(items) => void choose(items)}
        />
        {checking && <p role="status">{m.candidate_loading({}, options)}</p>}
        {failure && (
          <div className="space-y-1" role="alert">
            <EditorFailure locale={locale} reason={failure} />
            <p>{m.addon_base_check_failed({}, options)}</p>
          </div>
        )}
        {draft && (
          <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-card p-4">
            <p className="text-sm text-muted-foreground">{m.addon_base_draft_note({}, options)}</p>
            {target && exact && (
              <p className="text-sm">
                {pageText(exact.subject.labels, locale).text || m.subject_value_unlabelled({}, options)} ·{' '}
                <code className="break-all">{exact.subject.id}</code>
              </p>
            )}
            <fieldset disabled={!admitted} className="min-w-0">
              <GameStatementFields
                id={`addon-base-${draft.key}`}
                statement={draft.statement}
                context={context}
                locale={locale}
                search={search}
                valueControl={<PartValue part={draft.statement} read={context} locale={locale} />}
                editAllowed={() => canEdit && admitted}
                change={(statement) => {
                  if (canEdit && admitted) change({ ...draft, statement });
                }}
              />
            </fieldset>
            <GameInitialFactRemove
              row={draft}
              disabled={!canEdit}
              locale={locale}
              onRemove={() => {
                if (canEdit) change(undefined);
              }}
            />
          </ContentItemFrame>
        )}
      </fieldset>
    </section>
  );
}

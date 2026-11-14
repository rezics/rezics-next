import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { m } from '../../paraglide/messages.js';
import { IndependentMeasuresReadout } from '../independent-measures/editor';
import { measureValueKind } from '../independent-measures/contract';
import { EpisodeChecklistEditor } from '../episode-checklist/editor';
import { preparingVisit } from '../episode-checklist/controller';
import type { ProgressChoices } from '../progress-profile';
import { actionClass } from '../private-export/controls';
import { ProgressRecoveryJourney, type Snapshot } from './controller';
import type { ReviewInput } from './native';
import { Evidence, EvidenceDetails, progressModeLabel } from './review';

type Journey = ProgressRecoveryJourney<ProgressChoices>;
type View = Snapshot<ProgressChoices>;
const action = `${actionClass} rounded-md border disabled:opacity-50`;
const uuid = '[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';

export function MappingPanel({ journey, snap }: { journey: Journey; snap: View }) {
  const profilePairSelectId = useId();
  const additionalMeasureSelectId = useId();
  const source = snap.selected!;
  const [subject, setSubject] = useState('');
  const [pair, setPair] = useState('');
  const [additional, setAdditional] = useState<Record<string, string>>({});
  const [ids, setIds] = useState<string[]>([]);
  const locked = snap.busy || snap.pending;
  const pairs = snap.choices?.flatMap((choice) => choice.units.map((unit) => ({ mode: choice.mode, ...unit }))) ?? [];
  const choice = pairs.find((item) => `${item.mode}:${item.id}` === pair);
  const body: ReviewInput | null =
    choice && snap.mappedSubject
      ? {
          sessionId: source.session_id,
          subjectId: snap.mappedSubject,
          mode: choice.mode,
          unit: choice.id,
          additionalMeasures:
            choice.mode === 'scalar_amount'
              ? Object.entries(additional)
                  .filter(([, unit]) => unit)
                  .map(([sourceUnit, unit]) => ({ sourceUnit, unit }))
              : [],
          unitIds: choice.mode === 'completed_units' ? ids : [],
        }
      : null;
  const visit = preparingVisit(null);
  visit.kind = 'ready';
  visit.membership = 'admitted';
  visit.rows = (snap.units?.units ?? []).map(({ evidence }) => {
    const admission = snap.unitSupport.find((unit) => unit.unitId === evidence.unit_id)?.admission;
    return {
      episodeSubjectId: evidence.unit_id,
      completed: false,
      membership: admission ?? 'unavailable',
      ordinal: null,
      label: m.library_archive_present_title_unavailable(),
      source: 'inspect',
    };
  });
  visit.selection = { add: ids, remove: [] };
  const changed = () => journey.invalidateReview();
  const measures = [
    { unit: source.unit, amount: source.amount, total: source.total },
    ...(source.additional_measures ?? []),
  ];
  const profilePairOptions = [
    { value: null, label: m.library_archive_progress_choose() },
    ...pairs.map((item) => ({
      value: `${item.mode}:${item.id}`,
      label: `${progressModeLabel(item.mode)} · ${item.label || m.library_progress_unit_unspecified()}`,
    })),
  ];
  return (
    <section className="space-y-4 rounded-md border p-4">
      <h2 className="text-xl font-semibold">{m.library_archive_progress_mapping()}</h2>
      <details>
        <summary className={action}>{m.library_archive_progress_source()}</summary>
        <Evidence value={source} />
      </details>
      <IndependentMeasuresReadout
        revision={source.revision}
        measures={measures.map((item, index) => ({
          ...item,
          primary: index === 0,
          label: m.library_progress_unit_unspecified(),
          kind: measureValueKind(item.amount),
          meaning: 'unknown',
          recording: 'historical',
        }))}
      />
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPair('');
          setAdditional({});
          setIds([]);
          void journey.mapSubject(subject);
        }}
      >
        <label className="block space-y-2">
          <span>{m.library_archive_progress_subject()}</span>
          <input
            className={`${action} w-full`}
            required
            pattern={uuid}
            value={subject}
            disabled={locked}
            onChange={(event) => {
              setSubject(event.target.value);
              changed();
            }}
          />
        </label>
        <button className={action} disabled={locked}>
          {m.library_archive_progress_profile()}
        </button>
      </form>
      {snap.mappedSubject ? (
        <>
          <EvidenceDetails value={{ subjectId: snap.mappedSubject }} />
          {!pairs.length ? (
            <p>{m.library_archive_progress_unsupported()}</p>
          ) : (
            <Field className="block space-y-2">
              <FieldLabel id={`${profilePairSelectId}-label`} htmlFor={profilePairSelectId}>
                {m.library_archive_progress_pair()}
              </FieldLabel>
              <Select<string, false>
                items={profilePairOptions}
                disabled={locked}
                value={pair || null}
                onValueChange={(value) => {
                  setPair(value ?? '');
                  setAdditional({});
                  setIds([]);
                  changed();
                }}
              >
                <SelectTrigger
                  id={profilePairSelectId}
                  aria-labelledby={`${profilePairSelectId}-label`}
                  className={`${action} w-full`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {profilePairOptions.map(({ value, label, ...itemProps }) => (
                      <SelectItem key={value ?? ''} value={value} {...itemProps}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </>
      ) : null}
      {choice?.mode === 'scalar_amount'
        ? (source.additional_measures ?? []).map((measure, index) => {
            const additionalMeasureOptions = [
              { value: null, label: m.library_archive_progress_omit() },
              ...pairs
                .filter(
                  (item) =>
                    item.mode === 'scalar_amount' &&
                    item.id !== choice.id &&
                    !Object.entries(additional).some(
                      ([sourceUnit, unit]) => sourceUnit !== measure.unit && unit === item.id,
                    ),
                )
                .map((item) => ({ value: item.id, label: item.label || m.library_progress_unit_unspecified() })),
            ];
            return (
              <Field key={measure.unit} className="block space-y-2">
                <FieldLabel
                  id={`${additionalMeasureSelectId}-${measure.unit}-label`}
                  htmlFor={`${additionalMeasureSelectId}-${measure.unit}`}
                >
                  {
                    <>
                      {m.library_archive_present_item({ number: index + 1 })} · {m.library_progress_unit_unspecified()}{' '}
                      · {measure.amount ?? m.library_progress_measure_absent()} /{' '}
                      {measure.total ?? m.library_progress_measure_absent()}
                    </>
                  }
                </FieldLabel>
                <Select<string, false>
                  items={additionalMeasureOptions}
                  disabled={locked}
                  value={additional[measure.unit] || null}
                  onValueChange={(value) => {
                    setAdditional({ ...additional, [measure.unit]: value ?? '' });
                    changed();
                  }}
                >
                  <SelectTrigger
                    id={`${additionalMeasureSelectId}-${measure.unit}`}
                    aria-labelledby={`${additionalMeasureSelectId}-${measure.unit}-label`}
                    className={`${action} w-full`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {additionalMeasureOptions.map(({ value, label, ...itemProps }) => (
                        <SelectItem key={value ?? ''} value={value} {...itemProps}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            );
          })
        : null}
      <section className="space-y-3">
        <h3 className="font-semibold">{m.library_archive_progress_units()}</h3>
        <p>{m.library_archive_progress_unit_help({ count: source.completed_unit_count })}</p>
        <EvidenceDetails value={snap.units} />
        {choice?.mode === 'completed_units' && body ? (
          <>
            <button
              className={action}
              disabled={locked}
              onClick={() =>
                void journey.review(
                  { ...body, unitIds: snap.units!.units.map(({ evidence }) => evidence.unit_id) },
                  true,
                )
              }
            >
              {m.library_archive_progress_membership()}
            </button>
            <EpisodeChecklistEditor
              visit={visit}
              busy={locked}
              onToggle={(id) => {
                if (ids.includes(id)) setIds(ids.filter((value) => value !== id));
                else if (ids.length < 20) setIds([...ids, id]);
                changed();
              }}
              onClear={() => {
                setIds([]);
                changed();
              }}
              onReview={() => body && void journey.review(body)}
            />
            <p>{m.library_archive_progress_selected({ count: ids.length })}</p>
          </>
        ) : null}
        <Pager
          next={snap.units?.next}
          disabled={locked}
          onFirst={() => void journey.page('units')}
          onNext={(after) => void journey.page('units', after)}
        />
      </section>
      <button className={action} disabled={locked || !body} onClick={() => body && void journey.review(body)}>
        {m.library_archive_progress_review()}
      </button>
    </section>
  );
}

export function Pager({
  next,
  disabled,
  onFirst,
  onNext,
}: {
  next: number | null | undefined;
  disabled: boolean;
  onFirst: () => void;
  onNext: (after: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <button className={action} disabled={disabled} onClick={onFirst}>
        {m.buyer_history_first()}
      </button>
      {next !== null && next !== undefined ? (
        <button className={action} disabled={disabled} onClick={() => onNext(next)}>
          {m.buyer_history_next()}
        </button>
      ) : null}
    </div>
  );
}

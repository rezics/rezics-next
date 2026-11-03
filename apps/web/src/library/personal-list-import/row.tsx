import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useId, useState } from 'react';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { readVndbTargetStates } from './server';
import type { VndbReviewInput, VndbRow, VndbState } from './contract';
import { VndbAction, VndbCheck } from './controls';
import { VndbEvidence } from './fields';
import { VndbTargetSearch } from './target';

type StateChoice = { id: string; label: string };

function labelFor(state: VndbState): string {
  const locale = getLocale();
  return state.labels[locale] ?? state.labels[locale.split('-')[0]!] ?? Object.values(state.labels)[0] ?? state.id;
}

export function VndbRowReview({
  row,
  busy,
  onReview,
}: {
  row: VndbRow;
  busy: boolean;
  onReview: (body: VndbReviewInput) => void;
}) {
  const id = useId();
  const notMappable = row.kind === 'retained' || row.match.status === 'unsupported';
  const [action, setAction] = useState<'state' | 'skip' | 'retain'>(notMappable ? 'retain' : 'state');
  const [target, setTarget] = useState<EntityPickerSubject | null>(null);
  const [states, setStates] = useState<StateChoice[]>([]);
  const [stateId, setStateId] = useState('');
  const [replace, setReplace] = useState(false);
  const [loading, setLoading] = useState(false);
  const baseline =
    row.target && target?.id === row.target.targetId
      ? row.target.baseline
      : row.decision && target?.id === row.decision.targetId
        ? row.decision.baseline
        : null;

  useEffect(() => {
    let current = true;
    setStates([]);
    setStateId('');
    if (!target) {
      setLoading(false);
      return () => {
        current = false;
      };
    }
    const native =
      target.id === row.target?.targetId
        ? row.target.states.map((item) => ({ id: item.id, label: labelFor(item) }))
        : null;
    if (native) {
      setStates(native);
      setLoading(false);
      return () => {
        current = false;
      };
    }
    const type = target.types[0];
    if (!type) {
      setLoading(false);
      return () => {
        current = false;
      };
    }
    setLoading(true);
    void readVndbTargetStates({ data: { type } })
      .then((options) => {
        if (!current) return;
        setStates(options.map((option) => ({ id: option.id, label: option.label.text })));
        setLoading(false);
      })
      .catch(() => {
        if (current) {
          setStates([]);
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [row.target, target]);

  function selectAction(next: 'state' | 'skip' | 'retain') {
    setAction(next);
    setReplace(false);
  }

  function save() {
    if (action === 'state') {
      if (!target || !stateId || !states.some((item) => item.id === stateId)) return;
      onReview({ ordinal: row.ordinal, action, targetId: target.id, state: stateId, replace });
    } else {
      onReview({ ordinal: row.ordinal, action });
    }
  }

  return (
    <article
      className="min-w-0 space-y-4 rounded-lg border p-4"
      data-vndb-row={row.ordinal}
      data-vndb-match={row.match.status}
    >
      <header className="space-y-1">
        <h3 className="break-words text-lg font-medium">{row.title || m.library_vndb_untitled()}</h3>
        {row.identifier ? (
          <p className="break-words text-sm">{m.library_vndb_identifier({ value: row.identifier.value })}</p>
        ) : null}
        <p className="break-words text-sm text-muted-foreground">
          {m.library_vndb_match({ status: row.match.status })}
        </p>
        {row.match.candidates.length ? (
          <p className="break-words text-sm">{m.library_vndb_candidates({ ids: row.match.candidates.join(', ') })}</p>
        ) : null}
        {row.decision ? <p role="status">{m.library_vndb_review_status({ status: row.decision.status })}</p> : null}
      </header>
      <VndbEvidence row={row} />
      {row.kind === 'retained' ? <p>{m.library_vndb_metadata_row()}</p> : null}
      <fieldset className="space-y-3">
        <legend className="font-medium">{m.library_vndb_review_action()}</legend>
        <div className="flex flex-wrap gap-2">
          {(notMappable ? (['skip', 'retain'] as const) : (['state', 'skip', 'retain'] as const)).map((choice) => (
            <VndbAction
              key={choice}
              type="button"
              variant={action === choice ? 'default' : 'outline'}
              disabled={busy}
              aria-pressed={action === choice}
              onClick={() => selectAction(choice)}
            >
              {choice === 'state'
                ? m.library_vndb_action_state()
                : choice === 'skip'
                  ? m.library_vndb_action_skip()
                  : m.library_vndb_action_retain()}
            </VndbAction>
          ))}
        </div>
      </fieldset>
      {action === 'state' && !notMappable ? (
        <div className="space-y-3">
          <VndbTargetSearch
            disabled={busy}
            value={target}
            onChange={(next) => {
              setTarget(next);
              setStateId('');
              setReplace(false);
            }}
          />
          {target ? (
            <Field>
              <FieldLabel htmlFor={`${id}-state`} className="min-h-11 items-center">
                {m.library_vndb_state_label()}
              </FieldLabel>
              <select
                id={`${id}-state`}
                className="min-h-11 w-full rounded-md border bg-background px-3"
                value={stateId}
                disabled={busy || loading || states.length === 0}
                onChange={(event) => setStateId(event.currentTarget.value)}
              >
                <option value="">{m.library_vndb_state_choose()}</option>
                {states.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              {loading ? <p role="status">{m.library_vndb_states_loading()}</p> : null}
              {target.types.length === 0 || (!loading && states.length === 0) ? (
                <p role="status">{m.library_vndb_states_unavailable()}</p>
              ) : null}
            </Field>
          ) : null}
          {row.suggestedRole ? <p>{m.library_vndb_role_is_only_suggestion({ role: row.suggestedRole })}</p> : null}
          {baseline ? <p>{m.library_bangumi_current({ state: baseline.state, revision: baseline.revision })}</p> : null}
          {baseline ? (
            <VndbCheck
              id={`${id}-replace`}
              checked={replace}
              disabled={busy}
              label={m.library_bangumi_replace()}
              onToggle={setReplace}
            />
          ) : null}
        </div>
      ) : null}
      {notMappable ? <p>{m.library_vndb_unmappable_help()}</p> : null}
      <VndbAction
        type="button"
        disabled={busy || (action === 'state' && (!target || !stateId || loading))}
        onClick={save}
      >
        {m.library_bangumi_save_review()}
      </VndbAction>
    </article>
  );
}

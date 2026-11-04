import type { OwnerLeaf } from '@rezics/filter';
import type { LibraryProfile } from '@rezics/definitions';
import { m } from '../../paraglide/messages.js';
import { localizedLabel } from '../../search/results';
import type { ChoiceState, RuleChoices } from '../collection-rule-read';

type OwnerReviewProps = {
  exact: string;
  profiles: readonly LibraryProfile[];
  profileState: ChoiceState;
  labels: RuleChoices['labels'];
  locale: string;
};

type OwnerValue = OwnerLeaf['owner'];

function parseOwner(value: string): OwnerValue | null {
  try {
    const document: unknown = JSON.parse(value);
    return document && typeof document === 'object' && 'owner' in document
      ? (document as OwnerLeaf).owner
      : null;
  } catch {
    return null;
  }
}

function profileHint(profileState: ChoiceState, profile: LibraryProfile | undefined) {
  if (profileState !== 'ready')
    return profileState === 'preparing' ? m.library_rule_preparing() : m.library_rule_review_metadata_unavailable();
  return profile ? null : m.library_rule_review_unknown_reference();
}

function Descriptor({ label, id, name }: { label: string; id: string; name?: string | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="break-words">
        {name ? <span>{name} · </span> : null}
        <code className="break-all">{id}</code>
      </p>
    </div>
  );
}

function ProfileDescriptor({
  id,
  profileState,
  profiles,
  purpose,
}: {
  id: string;
  profileState: ChoiceState;
  profiles: readonly LibraryProfile[];
  purpose: string;
}) {
  const profile = profiles.find((entry) => entry.id === id);
  const hint = profileHint(profileState, profile);
  return (
    <>
      <Descriptor label={`${m.library_rule_profile()} · ${purpose}`} id={id} />
      {hint ? <p role="status">{hint}</p> : null}
      {profile ? (
        <p className="text-sm text-muted-foreground">
          {m.library_rule_review_profile_capabilities({
            states: profile.entryStateSet ? m.library_rule_state_set() : m.library_rule_review_not_provided(),
            progress: profile.progress ? m.library_rule_session() : m.library_rule_review_not_provided(),
            holdings: profile.copies ? m.library_rule_holding() : m.library_rule_review_not_provided(),
          })}
        </p>
      ) : null}
    </>
  );
}

function StateCondition({
  value,
  profiles,
  profileState,
  locale,
}: {
  value: Extract<OwnerValue, { state: unknown }>['state'];
  profiles: readonly LibraryProfile[];
  profileState: ChoiceState;
  locale: string;
}) {
  const profile = profiles.find((entry) => entry.id === value.profileId);
  const stateSet = profile?.entryStateSet;
  const setMatches = stateSet?.id === value.stateSetId;
  const selected = value.in.map((id) => ({
    id,
    name: setMatches ? stateSet?.states.find((entry) => entry.id === id)?.labels : undefined,
  }));
  return (
    <>
      <ProfileDescriptor
        id={value.profileId}
        profileState={profileState}
        profiles={profiles}
        purpose={m.library_rule_state()}
      />
      <Descriptor
        label={m.library_rule_state_set()}
        id={value.stateSetId}
      />
      {profileState !== 'ready' || !stateSet ? (
        <p role="status">
          {profileState === 'preparing' ? m.library_rule_preparing() : m.library_rule_review_metadata_unavailable()}
        </p>
      ) : !setMatches ? (
        <p role="status">{m.library_rule_state_set_unavailable()}</p>
      ) : null}
      <div>
        <p className="text-sm font-medium">{m.library_rule_state()}</p>
        {selected.length ? (
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {selected.map(({ id, name }) => (
              <li key={id} className="break-words">
                {name ? `${localizedLabel(name, locale).text} · ` : null}
                {!name && profileState === 'ready' && setMatches ? (
                  <span>{m.library_rule_review_unknown_reference()} </span>
                ) : null}
                <code className="break-all">{id}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{m.library_rule_review_no_selected_values()}</p>
        )}
      </div>
    </>
  );
}

function LabelCondition({
  id,
  labels,
}: {
  id: string;
  labels: RuleChoices['labels'];
}) {
  const choice = labels.values.find((entry) => entry.id === id);
  return (
    <>
      <Descriptor label={m.library_rule_label()} id={id} name={choice?.name} />
      {!choice ? (
        <p role="status">
          {labels.state === 'ready'
            ? m.library_rule_review_choice_unlisted()
            : labels.state === 'preparing'
              ? m.library_rule_preparing()
              : m.library_rule_labels_unavailable()}
        </p>
      ) : null}
    </>
  );
}

function SessionCondition({
  value,
  profiles,
  profileState,
  locale,
}: {
  value: Extract<OwnerValue, { session: unknown }>['session'];
  profiles: readonly LibraryProfile[];
  profileState: ChoiceState;
  locale: string;
}) {
  const profile = profiles.find((entry) => entry.id === value.profileId);
  const lifecycle =
    value.lifecycle === 'active'
      ? m.library_rule_active()
      : value.lifecycle === 'completed'
        ? m.library_rule_completed()
        : m.library_rule_abandoned();
  return (
    <>
      <ProfileDescriptor
        id={value.profileId}
        profileState={profileState}
        profiles={profiles}
        purpose={m.library_rule_session()}
      />
      <Descriptor label={m.library_rule_session()} id={value.lifecycle} name={lifecycle} />
      {profile?.progress ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{m.library_rule_review_progress_meaning()}</p>
          {profile.progress.allowed.length ? (
            <ul className="list-disc space-y-2 pl-5">
              {profile.progress.allowed.map(({ mode, units }) => (
                <li key={mode}>
                  <p className="font-medium">{progressModeLabel(mode)}</p>
                  {units.length ? (
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {units.map((unit) => (
                        <li key={unit.id} className="break-words">
                          {localizedLabel(unit.labels, locale).text} · <code>{unit.id}</code>
                          {unit.dimension ? (
                            <span>
                              {' · '}{m.library_rule_review_dimension()} <code>{unit.dimension}</code>
                            </span>
                          ) : null}
                          {unit.minimum || unit.maximum ? (
                            <span>
                              {' · '}{m.library_rule_review_bounds()} <code>{unit.minimum ?? '−∞'}–{unit.maximum ?? '∞'}</code>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">{m.library_rule_review_no_selected_values()}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{m.library_rule_review_not_provided()}</p>
          )}
        </div>
      ) : null}
    </>
  );
}

function progressModeLabel(mode: string) {
  if (mode === 'cursor_position') return m.library_rule_review_mode_cursor();
  if (mode === 'completed_units') return m.library_rule_review_mode_completed();
  return m.library_rule_review_mode_amount();
}

function HoldingCondition({
  value,
  profiles,
  profileState,
  locale,
}: {
  value: Extract<OwnerValue, { holding: unknown }>['holding'];
  profiles: readonly LibraryProfile[];
  profileState: ChoiceState;
  locale: string;
}) {
  const profile = profiles.find((entry) => entry.id === value.profileId);
  const kind = profile?.copies?.kinds.find((entry) => entry.id === value.kind);
  const status = kind?.statuses.find((entry) => entry.id === value.status);
  return (
    <>
      <ProfileDescriptor
        id={value.profileId}
        profileState={profileState}
        profiles={profiles}
        purpose={m.library_rule_holding()}
      />
      {value.kind ? (
        <Descriptor
          label={m.library_rule_holding_kind()}
          id={value.kind}
          name={kind ? localizedLabel(kind.labels, locale).text : undefined}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{m.library_rule_review_any_holding_kind()}</p>
      )}
      {value.status ? (
        <Descriptor
          label={m.library_rule_holding_status()}
          id={value.status}
          name={status ? localizedLabel(status.labels, locale).text : undefined}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{m.library_rule_review_any_holding_status()}</p>
      )}
      {profileState !== 'ready' ? (
        <p role="status">
          {profileState === 'preparing' ? m.library_rule_preparing() : m.library_rule_review_metadata_unavailable()}
        </p>
      ) : !profile ? (
        <p role="status">{m.library_rule_review_unknown_reference()}</p>
      ) : value.kind && !kind ? (
        <p role="status">{m.library_rule_review_unknown_reference()}</p>
      ) : value.status && !status ? (
        <p role="status">{m.library_rule_review_unknown_reference()}</p>
      ) : null}
    </>
  );
}

/** Owner facts stay visibly distinct from public properties; this component only describes their supplied AST. */
export function OwnerConditionReview({ exact, profiles, profileState, labels, locale }: OwnerReviewProps) {
  const owner = parseOwner(exact);
  if (!owner)
    return (
      <aside className="space-y-2 rounded-md border border-border p-3">
        <h4 className="font-medium">{m.saved_filter_review_owner()}</h4>
        <p role="status">{m.library_rule_review_metadata_unavailable()}</p>
        <code className="break-all">{exact}</code>
      </aside>
    );

  const detail = 'presence' in owner ? (
    <p>{m.library_rule_presence()}</p>
  ) : 'label' in owner ? (
    <LabelCondition id={owner.label.id} labels={labels} />
  ) : 'state' in owner ? (
    <StateCondition value={owner.state} profiles={profiles} profileState={profileState} locale={locale} />
  ) : 'session' in owner ? (
    <SessionCondition value={owner.session} profiles={profiles} profileState={profileState} locale={locale} />
  ) : (
    <HoldingCondition value={owner.holding} profiles={profiles} profileState={profileState} locale={locale} />
  );
  return (
    <aside className="min-w-0 space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <h4 className="font-medium">{m.saved_filter_review_owner()}</h4>
      <p className="text-sm text-muted-foreground">{m.library_rule_review_owner_only()}</p>
      <div className="min-w-0 space-y-2">{detail}</div>
    </aside>
  );
}

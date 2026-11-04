import type { FilterDocument } from '@rezics/filter';
import { memo, useMemo } from 'react';
import type { LibraryProfile } from '@rezics/definitions';
import type { ConditionMetadata } from '../../search/condition-editor-model';
import { localizedLabel } from '../../search/results';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { RuleChoices, SavedRule } from '../collection-rule-read';
import { savedFilterReviewTree, type CurrentFieldState, type ReviewOperand, type ReviewTree } from '../saved-filter-review/model';
import type { ReviewRelease } from '../saved-filter-review/read';
import { OwnerConditionReview } from './owner';

export type RuleReviewStage = 'draft' | 'submitted' | 'confirmed' | 'saved' | 'current';

export type RuleReviewRelease = {
  state: 'ready' | 'preparing' | 'unavailable';
  digest?: string;
  metadata?: ConditionMetadata;
};

export type DynamicRuleReviewProps = {
  filter: FilterDocument;
  stage: RuleReviewStage;
  current: RuleReviewRelease;
  accepted?: RuleReviewRelease;
  choices: RuleChoices;
  profiles?: readonly LibraryProfile[];
  profileState?: RuleReviewRelease['state'];
  basis?: SavedRule | undefined;
  basisKind?: 'loaded' | 'original' | undefined;
  collectionId?: string | undefined;
  returnedId?: string | undefined;
  ownerCurrent: boolean;
};

type ReviewLabels = Record<string, Record<string, Record<string, string>>>;

function release(value: RuleReviewRelease): ReviewRelease {
  return {
    state: value.state,
    ...(value.digest ? { digest: value.digest } : {}),
    ...(value.metadata ? { metadata: value.metadata } : {}),
  };
}

function currentStateText(state: CurrentFieldState) {
  if (state === 'removed') return m.saved_filter_review_field_removed();
  if (state === 'changed') return m.saved_filter_review_definition_changed();
  if (state === 'missing-label') return m.saved_filter_review_label_missing();
  if (state === 'unavailable') return m.saved_filter_review_current_unavailable();
  return null;
}

function stateMessage(state: RuleReviewRelease['state']) {
  if (state === 'ready') return null;
  return state === 'preparing' ? m.library_rule_preparing() : m.library_rule_review_metadata_unavailable();
}

function stageMessage(stage: RuleReviewStage) {
  if (stage === 'submitted') return m.library_rule_review_submitted();
  if (stage === 'confirmed') return m.library_rule_review_confirmed();
  if (stage === 'saved') return m.library_rule_review_saved();
  if (stage === 'current') return m.library_rule_review_current();
  return m.library_rule_review_draft();
}

function Basis({
  basis,
  kind,
  collectionId,
  ownerCurrent,
}: {
  basis: SavedRule | undefined;
  kind: 'loaded' | 'original' | undefined;
  collectionId: string | undefined;
  ownerCurrent: boolean;
}) {
  if (!basis) return null;
  return (
    <details className="min-w-0 rounded-md border border-border p-3" open={kind === 'original'}>
      <summary className="min-h-11 cursor-pointer content-center font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
        {m.library_rule_review_saved_basis()}
      </summary>
      <p className="my-2 text-sm text-muted-foreground">
        {kind === 'original' ? m.library_rule_review_original_basis() : m.library_rule_review_loaded_basis()}
      </p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        {collectionId ? (
          <div className="min-w-0">
            <dt className="text-sm text-muted-foreground">{m.library_rule_review_collection()}</dt>
            <dd className="break-all">
              <code>{collectionId}</code>
            </dd>
          </div>
        ) : null}
        {[
          { label: m.library_rule_revision(), value: basis.revision },
          { label: m.library_rule_collection_revision(), value: basis.collectionRevision },
          { label: m.library_rule_release(), value: basis.releaseDigest },
          { label: m.library_rule_source_generation(), value: basis.sourceGeneration },
        ].map(({ label, value }) => (
          <div key={label} className="min-w-0">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="break-all">
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm" role={ownerCurrent ? 'status' : 'alert'}>
        {ownerCurrent ? m.library_rule_review_owner_verified() : m.library_rule_review_owner_changed()}
      </p>
    </details>
  );
}

function ReleaseStatus({ label, value }: { label: string; value: RuleReviewRelease }) {
  const failure = stateMessage(value.state);
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-all">
        {value.digest ? <code>{value.digest}</code> : <span>{failure ?? m.library_rule_review_metadata_unavailable()}</span>}
      </dd>
      {failure ? <p className="mt-1 text-sm text-muted-foreground">{failure}</p> : null}
    </div>
  );
}

function FieldIdentity({ value }: { value: ReviewOperand }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-medium">{value.role === 'type' ? m.saved_filter_review_type() : m.saved_filter_review_property()}</span>
      {value.fieldId ? <code className="break-all">{value.fieldId}</code> : null}
      <code>{value.operation}</code>
      {value.datatype ? (
        <span className="text-sm text-muted-foreground">
          {m.library_rule_review_datatype()} <code>{value.datatype}</code>
        </span>
      ) : null}
    </div>
  );
}

function LabelPair({ accepted, current }: { accepted?: string | undefined; current?: string | undefined }) {
  if (!accepted && !current) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm">
      {accepted ? (
        <p>
          {m.saved_filter_review_accepted_label()} {accepted}
        </p>
      ) : null}
      {current ? (
        <p>
          {m.saved_filter_review_current_label()} {current}
        </p>
      ) : null}
    </div>
  );
}

function ExactValues({
  values,
  labels,
  property,
  locale,
}: {
  values: NonNullable<ReviewOperand['values']>;
  labels: ReviewLabels;
  property: string | undefined;
  locale: string;
}) {
  return (
    <ul className="min-w-0 space-y-2">
      {values.map((entry, index) => {
        const currentValue = property ? labels[property]?.[entry.exact] : undefined;
        const currentLabel = currentValue ? localizedLabel(currentValue, locale).text : entry.currentTypeLabel;
        return (
          <li key={`${entry.exact}:${index}`} className="min-w-0 break-words">
            <LabelPair accepted={entry.acceptedLabel} current={currentLabel} />
            {property && !currentLabel ? (
              <span className="mr-2 text-sm text-muted-foreground">{m.library_rule_review_exact_value()}</span>
            ) : null}
            <code className="break-all">{entry.exact}</code>
          </li>
        );
      })}
    </ul>
  );
}

function Operand({
  value,
  choices,
  profiles,
  profileState,
  locale,
  labels,
}: {
  value: ReviewOperand;
  choices: RuleChoices;
  profiles: readonly LibraryProfile[];
  profileState: RuleReviewRelease['state'];
  locale: string;
  labels: ReviewLabels;
}) {
  if (value.role === 'owner')
    return (
      <li key={value.path || 'owner'} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
        <OwnerConditionReview
          exact={value.exact ?? ''}
          profiles={profiles}
          profileState={profileState}
          labels={choices.labels}
          locale={locale}
        />
      </li>
    );

  const roleLabel = value.role === 'type' ? m.saved_filter_review_type() : value.role === 'saved' ? m.saved_filter_review_group_saved() : m.saved_filter_review_property();
  return (
    <li key={value.path || 'operand'} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      {value.role === 'saved' ? (
        <div className="space-y-2">
          <p className="font-medium">{roleLabel}</p>
          {value.fieldId ? <code className="break-all">{value.fieldId}</code> : null}
          <p role="status">{m.library_rule_review_unknown_reference()}</p>
        </div>
      ) : (
        <>
          <FieldIdentity value={value} />
          <LabelPair accepted={value.acceptedLabel} current={value.currentLabel} />
          {currentStateText(value.currentState) ? (
            <p role="status">{currentStateText(value.currentState)}</p>
          ) : null}
          {value.values?.length ? (
            <ExactValues values={value.values} labels={labels} property={value.fieldId} locale={locale} />
          ) : null}
          {value.range ? (
            <p className="break-words">
              {m.saved_filter_review_range()} <code>{JSON.stringify(value.range)}</code>
            </p>
          ) : null}
          {value.qualifiers?.length ? (
            <ul className="min-w-0 space-y-2 border-l-2 border-border pl-3">
              {value.qualifiers.map((qualifier, index) => (
                <li key={`${qualifier.property}:${index}`} className="min-w-0 space-y-1">
                  <p className="font-medium">{m.saved_filter_review_qualifier()}</p>
                  <LabelPair accepted={qualifier.acceptedLabel} current={qualifier.currentLabel} />
                  <code className="break-all">{qualifier.property}</code>
                  {currentStateText(qualifier.currentState) ? (
                    <p role="status">{currentStateText(qualifier.currentState)}</p>
                  ) : null}
                  <ExactValues values={qualifier.values} labels={labels} property={qualifier.property} locale={locale} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </li>
  );
}

function Tree({
  value,
  choices,
  profiles,
  profileState,
  locale,
  labels,
}: {
  value: ReviewTree;
  choices: RuleChoices;
  profiles: readonly LibraryProfile[];
  profileState: RuleReviewRelease['state'];
  locale: string;
  labels: ReviewLabels;
}) {
  if (value.kind === 'operand')
    return (
      <Operand
        value={value.value}
        choices={choices}
        profiles={profiles}
        profileState={profileState}
        locale={locale}
        labels={labels}
      />
    );
  const title =
    value.operator === 'and'
      ? m.saved_filter_review_group_and()
      : value.operator === 'or'
        ? m.saved_filter_review_group_or()
        : value.operator === 'not'
          ? m.saved_filter_review_group_not()
          : m.saved_filter_review_group_saved();
  return (
    <li key={value.path || 'root'} className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <p className="font-medium">
        {title}
        {value.reference ? (
          <>
            {' · '}<code className="break-all">{value.reference}</code>
          </>
        ) : null}
      </p>
      <ul className="min-w-0 space-y-2 border-l-2 border-border pl-3">
        {value.children.map((child) => (
          <Tree
            key={child.kind === 'group' ? child.path : child.value.path}
            value={child}
            choices={choices}
            profiles={profiles}
            profileState={profileState}
            locale={locale}
            labels={labels}
          />
        ))}
      </ul>
    </li>
  );
}

/** A read-only rendering of the admitted grammar. It does not find, count, sort, or evaluate members. */
export const DynamicRuleReview = memo(function DynamicRuleReview({
  filter,
  stage,
  current,
  accepted,
  choices,
  profiles,
  profileState,
  basis,
  basisKind,
  collectionId,
  returnedId,
  ownerCurrent,
}: DynamicRuleReviewProps) {
  const locale = getLocale();
  const acceptedRelease = accepted ?? current;
  const acceptedMeaning = useMemo(() => release(acceptedRelease), [acceptedRelease]);
  const currentMeaning = useMemo(() => release(current), [current]);
  const tree = useMemo(
    () => (ownerCurrent ? savedFilterReviewTree(filter, acceptedMeaning, currentMeaning, locale) : null),
    [acceptedMeaning, currentMeaning, filter, locale, ownerCurrent],
  );
  if (!ownerCurrent || !tree)
    return (
      <section role="alert" className="rounded-lg border border-destructive/50 p-4">
        <h2 className="font-semibold">{m.library_rule_review_heading()}</h2>
        <p>{m.library_rule_review_owner_changed()}</p>
      </section>
    );
  const currentIssue = stateMessage(current.state);
  const acceptedIssue = stateMessage(acceptedRelease.state);
  const ownerProfiles = profiles ?? choices.release.profiles;
  const ownerProfileState = profileState ?? current.state;
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border p-4" aria-labelledby="rule-review-heading">
      <div className="space-y-2">
        <h2 id="rule-review-heading" className="text-lg font-semibold">
          {m.library_rule_review_heading()}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{m.library_rule_review_intro()}</p>
        <p role="status" className="font-medium">{stageMessage(stage)}</p>
        {returnedId ? (
          <p className="break-all">
            {m.library_rule_review_confirmed_collection()} <code>{returnedId}</code>
          </p>
        ) : null}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">{m.library_rule_review_no_evaluation()}</p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <ReleaseStatus label={m.saved_filter_review_accepted_release()} value={acceptedRelease} />
        <ReleaseStatus label={m.saved_filter_review_current_release()} value={current} />
      </dl>
      {acceptedIssue ? <p role="status">{acceptedIssue}</p> : null}
      {currentIssue ? <p role="status">{currentIssue}</p> : null}
      <p className="text-sm text-muted-foreground">{m.library_rule_review_release_scope()}</p>
      <Basis basis={basis} kind={basisKind} collectionId={collectionId} ownerCurrent={ownerCurrent} />
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">{m.saved_filter_review_operands()}</h3>
        <ul className="min-w-0 space-y-3">
          <Tree
            value={tree}
            choices={choices}
            profiles={ownerProfiles}
            profileState={ownerProfileState}
            locale={locale}
            labels={{}}
          />
        </ul>
      </div>
      <details className="min-w-0">
        <summary className="min-h-11 cursor-pointer content-center underline underline-offset-4 focus-visible:outline-2">
          {m.saved_filter_review_exact()}
        </summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(filter, null, 2)}
        </pre>
      </details>
    </section>
  );
});

export function ruleReviewReleaseFromChoices(choices: RuleChoices): RuleReviewRelease {
  return {
    state: choices.release.state,
    ...(choices.release.digest ? { digest: choices.release.digest } : {}),
    ...(choices.release.metadata ? { metadata: choices.release.metadata } : {}),
  };
}

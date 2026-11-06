import { useEffect, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import type {
  BangumiCommand,
  BangumiFailure,
  BangumiImportPort,
  BangumiLabelApplyData,
  BangumiLabelPanelState,
  BangumiLabelState,
  BangumiTag,
} from './contract';
import { newCommandKey } from './contract';
import { BangumiAction } from './controls';
import { bangumiFailureLabel } from './meaning';
import type { BangumiVisit } from './visit';

export function emptyBangumiLabelPanel(rowRevision: string | null): BangumiLabelPanelState {
  return {
    rowRevision,
    pages: [],
    pageIndex: 0,
    custody: null,
    mappings: {},
    reviewedMappings: null,
    newNames: {},
    queries: {},
    options: {},
    searchState: {},
    labels: null,
    result: null,
    assignments: null,
    assignmentState: 'idle',
    command: null,
    notice: null,
    busy: false,
  };
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)!;
}

function evidenceLabel(evidence: string): string {
  if (evidence === 'missing') return m.library_bangumi_label_evidence_missing();
  if (evidence === 'empty') return m.library_bangumi_label_evidence_empty();
  if (evidence === 'known') return m.library_bangumi_label_evidence_known();
  if (evidence === 'invalid') return m.library_bangumi_label_evidence_invalid();
  return m.library_bangumi_label_evidence_unknown();
}

function outcomeLabel(status: string): string {
  if (status === 'assigned') return m.library_bangumi_label_outcome_assigned();
  if (status === 'unchanged') return m.library_bangumi_label_outcome_unchanged();
  if (status === 'duplicate') return m.library_bangumi_label_outcome_duplicate();
  if (status === 'invalid') return m.library_bangumi_label_outcome_invalid();
  if (status === 'stale') return m.library_bangumi_label_outcome_stale();
  if (status === 'capacity') return m.library_bangumi_label_outcome_capacity();
  if (status === 'conflict') return m.library_bangumi_label_outcome_conflict();
  if (status === 'limit') return m.library_bangumi_label_outcome_limit();
  return m.library_bangumi_label_outcome_failed();
}

function reviewItemLabel(status: string): string {
  if (status === 'ready') return m.library_bangumi_label_item_ready();
  if (status === 'duplicate') return m.library_bangumi_label_item_duplicate();
  return m.library_bangumi_label_item_invalid();
}

function outcomeSummary(result: BangumiLabelApplyData | null, labels: BangumiLabelState | null) {
  return result?.outcomes ?? labels?.outcomes ?? [];
}

export function BangumiLabelAdoption({
  uploadId,
  ordinal,
  rowRevision,
  port,
  visit,
  panel,
  onChange,
  disabled,
}: {
  uploadId: string;
  ordinal: number;
  rowRevision: string | null;
  port: BangumiImportPort;
  visit: BangumiVisit;
  panel: BangumiLabelPanelState | undefined;
  onChange: (update: (previous: BangumiLabelPanelState | undefined) => BangumiLabelPanelState) => void;
  disabled: boolean;
}) {
  const current = rowRevision
    ? panel?.rowRevision === rowRevision
      ? panel
      : {
          ...emptyBangumiLabelPanel(rowRevision),
          ...(panel?.command ? { command: panel.command } : {}),
          ...(panel?.custody ? { custody: panel.custody } : {}),
        }
    : null;
  const latest = useRef({ rowRevision, visit });
  latest.current = { rowRevision, visit };
  useEffect(() => {
    if (rowRevision && panel?.rowRevision !== rowRevision && !panel?.command)
      onChange(() => emptyBangumiLabelPanel(rowRevision));
  }, [onChange, panel?.command, panel?.rowRevision, rowRevision]);

  function isCurrent(expectedRevision: string | null): boolean {
    return (
      latest.current.rowRevision === expectedRevision &&
      latest.current.visit.current() &&
      !latest.current.visit.controller.signal.aborted
    );
  }

  function update(fn: (state: BangumiLabelPanelState) => BangumiLabelPanelState) {
    if (!current) return;
    onChange((previous) =>
      fn(
        !previous || previous.rowRevision !== current.rowRevision
          ? emptyBangumiLabelPanel(current.rowRevision)
          : previous,
      ),
    );
  }

  async function loadTags(after = -1, retryCommand?: Extract<BangumiCommand, { kind: 'tags' }>) {
    if (!current || !rowRevision || disabled || current.busy || (current.command && !retryCommand) || !visit.current())
      return;
    const command: Extract<BangumiCommand, { kind: 'tags' }> = retryCommand ?? {
      kind: 'tags',
      uploadId,
      ordinal,
      after,
      ...(current.custody ? { custody: current.custody } : {}),
    };
    update((state) => ({ ...state, busy: true, notice: null }));
    const response = await port.tags(command);
    if (!isCurrent(rowRevision)) return;
    if (response.kind === 'unknown') {
      update((state) => ({
        ...state,
        busy: false,
        command: response.command as Extract<BangumiCommand, { kind: 'tags' }>,
      }));
      return;
    }
    if (response.kind !== 'tags') {
      update((state) => ({ ...state, busy: false, notice: response as BangumiFailure }));
      return;
    }
    if (response.page.rowRevision !== rowRevision) {
      update((state) => ({ ...state, busy: false, notice: { kind: 'conflict' } }));
      return;
    }
    update((state) => {
      const index = state.pages.findIndex(
        (page) => page.tags[0]?.index === response.page.tags[0]?.index && page.tags.length > 0,
      );
      const pages = [...state.pages];
      if (index >= 0) pages[index] = response.page;
      else pages.push(response.page);
      return {
        ...state,
        busy: false,
        command: null,
        custody: response.custody ?? state.custody,
        pages,
        pageIndex: index >= 0 ? index : Math.max(0, pages.length - 1),
        labels: response.page.labels,
        reviewedMappings: null,
        notice: null,
      };
    });
  }

  async function search(index: number, fallback: string) {
    if (!current || disabled || current.busy || current.command || !visit.current()) return;
    const query = current.queries[index] ?? fallback;
    update((state) => ({
      ...state,
      busy: true,
      queries: { ...state.queries, [index]: query },
      searchState: { ...state.searchState, [index]: 'idle' },
      notice: null,
    }));
    const response = await port.searchLabels(query);
    if (!isCurrent(rowRevision)) return;
    if (response.kind !== 'label-options') {
      update((state) => ({
        ...state,
        busy: false,
        searchState: { ...state.searchState, [index]: 'unavailable' },
        notice: response,
      }));
      return;
    }
    update((state) => ({
      ...state,
      busy: false,
      options: { ...state.options, [index]: response.labels },
      searchState: { ...state.searchState, [index]: 'loaded' },
      notice: null,
    }));
  }

  async function reviewLabels() {
    if (!current || !rowRevision || !current.custody || disabled || current.busy || current.command || !visit.current())
      return;
    const mappings = Object.entries(current.mappings)
      .map(([index, target]) => ({ index: Number(index), target }))
      .sort((left, right) => left.index - right.index);
    if (!mappings.length || mappings.length > 16) return;
    const command: Extract<BangumiCommand, { kind: 'review-labels' }> = {
      kind: 'review-labels',
      uploadId,
      ordinal,
      rowRevision,
      mappings,
      key: newCommandKey(),
      custody: current.custody,
    };
    update((state) => ({ ...state, busy: true, command, notice: null, labels: null, result: null, assignments: null }));
    const response = await port.reviewLabels(command);
    if (!isCurrent(rowRevision)) return;
    if (response.kind === 'unknown') {
      update((state) => ({
        ...state,
        busy: false,
        command: response.command as Extract<BangumiCommand, { kind: 'review-labels' }>,
      }));
      return;
    }
    if (response.kind !== 'labels-reviewed') {
      update((state) => ({ ...state, busy: false, command: null, notice: response as BangumiFailure }));
      return;
    }
    update((state) => ({
      ...state,
      busy: false,
      command: null,
      labels: response.labels,
      reviewedMappings: command.mappings,
      result: null,
      assignments: null,
      assignmentState: 'idle',
      notice: null,
    }));
  }

  async function readAssignments(subjectId: string, expectedRevision: string | null) {
    if (!isCurrent(expectedRevision)) return;
    update((state) => ({ ...state, assignmentState: 'loading' }));
    const response = await port.readAssignments(subjectId);
    if (!isCurrent(expectedRevision)) return;
    if (response.kind !== 'assignments') {
      update((state) => ({ ...state, assignmentState: 'unavailable' }));
      return;
    }
    update((state) => ({ ...state, assignments: response.assignments, assignmentState: 'loaded' }));
  }

  async function applyLabels(command?: Extract<BangumiCommand, { kind: 'apply-labels' }>, retry = false) {
    if (!current || !rowRevision || disabled || current.busy || (!retry && current.command) || !visit.current()) return;
    const review = current.labels?.review;
    const canRetry =
      current.labels?.confirmed &&
      (current.labels.outcomes.some((outcome) => outcome.status === 'failed') ||
        (current.result?.remaining.length ?? 0) > 0);
    if (!command && (!review || !current.custody || (current.labels?.confirmed && !canRetry))) return;
    const exact: Extract<BangumiCommand, { kind: 'apply-labels' }> = command ?? {
      kind: 'apply-labels',
      uploadId,
      ordinal,
      reviewToken: review!.token,
      custody: current.custody!,
    };
    update((state) => ({ ...state, busy: true, command: exact, notice: null }));
    const response = await port.applyLabels(exact);
    if (!isCurrent(rowRevision)) return;
    if (response.kind === 'unknown') {
      update((state) => ({
        ...state,
        busy: false,
        command: response.command as Extract<BangumiCommand, { kind: 'apply-labels' }>,
      }));
      return;
    }
    if (response.kind !== 'labels-applied') {
      update((state) => ({ ...state, busy: false, command: null, notice: response as BangumiFailure }));
      return;
    }
    update((state) => ({ ...state, busy: false, command: null, result: response.result, notice: null }));
    await loadTagsForReadback(exact, rowRevision);
    if (review?.subject) await readAssignments(review.subject.subjectId, rowRevision);
  }

  async function loadTagsForReadback(
    command: Extract<BangumiCommand, { kind: 'apply-labels' }>,
    expectedRevision: string,
  ) {
    if (!isCurrent(expectedRevision)) return;
    const tagsCommand: Extract<BangumiCommand, { kind: 'tags' }> = {
      kind: 'tags',
      uploadId: command.uploadId,
      ordinal: command.ordinal,
      after: -1,
      custody: command.custody,
    };
    const response = await port.tags(tagsCommand);
    if (!isCurrent(expectedRevision)) return;
    if (response.kind === 'tags' && response.page.rowRevision === expectedRevision)
      update((state) => ({
        ...state,
        pages: [response.page],
        pageIndex: 0,
        labels: response.page.labels,
        custody: response.custody ?? state.custody,
      }));
  }

  async function retry() {
    const command = current?.command;
    if (!command || !current || !rowRevision || disabled || current.busy || !visit.current()) return;
    if (command.kind === 'tags') return loadTags(command.after, command);
    if (command.kind === 'review-labels') {
      update((state) => ({ ...state, busy: true, notice: null }));
      const response = await port.reviewLabels(command);
      if (!isCurrent(rowRevision)) return;
      if (response.kind === 'unknown') {
        update((state) => ({
          ...state,
          busy: false,
          command: response.command as Extract<BangumiCommand, { kind: 'review-labels' }>,
        }));
      } else if (response.kind === 'labels-reviewed') {
        update((state) => ({
          ...state,
          busy: false,
          command: null,
          labels: response.labels,
          reviewedMappings: command.mappings,
          notice: null,
        }));
      } else {
        update((state) => ({ ...state, busy: false, command: null, notice: response as BangumiFailure }));
      }
      return;
    }
    await applyLabels(command, true);
  }

  if (!rowRevision || !current) {
    return (
      <section className="space-y-2 rounded-md border p-4" data-bangumi-labels={ordinal}>
        <h4 className="font-medium">{m.library_bangumi_label_adoption()}</h4>
        <p className="text-sm text-muted-foreground">{m.library_bangumi_label_needs_subject_review()}</p>
      </section>
    );
  }

  const page = current.pages[current.pageIndex];
  const allTags: BangumiTag[] = current.pages.flatMap((item) => item.tags);
  const selectedCount = Object.keys(current.mappings).length;
  const selectedMappings = Object.entries(current.mappings)
    .map(([index, target]) => ({ index: Number(index), target }))
    .sort((left, right) => left.index - right.index);
  const exactSelection =
    current.reviewedMappings === null
      ? selectedMappings.length === 0
      : JSON.stringify(selectedMappings) === JSON.stringify(current.reviewedMappings);
  const outcomes = outcomeSummary(current.result, current.labels);
  const held = !!current.command;
  const retryableResults =
    current.labels?.confirmed &&
    (current.labels.outcomes.some((outcome) => outcome.status === 'failed') ||
      (current.result?.remaining.length ?? 0) > 0);
  const staleCommand =
    current.command &&
    current.command.kind !== 'tags' &&
    (current.command.kind === 'apply-labels' || current.command.rowRevision !== rowRevision);

  return (
    <details className="rounded-md border p-4" data-bangumi-labels={ordinal}>
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_bangumi_label_adoption()}</summary>
      <div className="space-y-4 pt-3">
        {staleCommand ? <p role="status">{m.library_bangumi_label_prior_command_pending()}</p> : null}
        {!current.pages.length ? <p className="text-sm">{m.library_bangumi_label_not_loaded()}</p> : null}
        <div className="flex flex-wrap gap-3">
          {!current.pages.length ? (
            <BangumiAction type="button" disabled={disabled || current.busy || held} onClick={() => void loadTags()}>
              {current.busy ? m.library_bangumi_label_loading() : m.library_bangumi_label_load_tags()}
            </BangumiAction>
          ) : (
            <BangumiAction
              type="button"
              variant="outline"
              disabled={disabled || current.busy || held}
              onClick={() => void loadTags()}
            >
              {m.library_bangumi_label_refresh_tags()}
            </BangumiAction>
          )}
          {page?.next !== null && page?.next !== undefined ? (
            <BangumiAction
              type="button"
              variant="outline"
              disabled={disabled || current.busy || held}
              onClick={() => void loadTags(page.next!)}
            >
              {m.library_bangumi_label_next_page()}
            </BangumiAction>
          ) : null}
          {current.pages.length > 1 ? (
            <BangumiAction
              type="button"
              variant="outline"
              disabled={current.pageIndex === 0}
              onClick={() => update((state) => ({ ...state, pageIndex: Math.max(0, state.pageIndex - 1) }))}
            >
              {m.library_bangumi_label_previous_page()}
            </BangumiAction>
          ) : null}
          {held ? (
            <BangumiAction type="button" disabled={disabled || current.busy} onClick={() => void retry()}>
              {m.library_bangumi_label_retry_original()}
            </BangumiAction>
          ) : null}
        </div>
        {current.notice ? (
          <p role="status">
            {current.notice.kind === 'conflict'
              ? m.library_bangumi_label_conflict_help()
              : bangumiFailureLabel(current.notice.kind, current.notice.detail)}
          </p>
        ) : null}
        {page ? (
          <div className="space-y-3">
            <p role="status">{evidenceLabel(page.evidence)}</p>
            {page.tags.length ? (
              <ul className="space-y-3">
                {page.tags.map((tag) => {
                  const target = current.mappings[tag.index];
                  const query = current.queries[tag.index] ?? tag.proposedName ?? textValue(tag.value);
                  return (
                    <li key={tag.index} className="space-y-3 rounded-md border p-3" data-bangumi-tag-index={tag.index}>
                      <p className="text-sm font-medium">{m.library_bangumi_label_tag_index({ index: tag.index })}</p>
                      <p className="break-words">
                        <span className="font-medium">{m.library_bangumi_label_source_text()}</span>{' '}
                        {textValue(tag.value)}
                      </p>
                      {tag.proposedName ? (
                        <p className="break-words">
                          <span className="font-medium">{m.library_bangumi_label_proposed_name()}</span>{' '}
                          {tag.proposedName}
                        </p>
                      ) : null}
                      {target ? (
                        <p className="break-words" data-bangumi-label-target={tag.index}>
                          {m.library_bangumi_label_mapping_selected({
                            target: 'labelId' in target ? target.labelId : target.name,
                          })}
                        </p>
                      ) : null}
                      {tag.status === 'supported' ? (
                        <div className="space-y-2">
                          <label
                            className="block text-sm font-medium"
                            htmlFor={`bangumi-new-label-${ordinal}-${tag.index}`}
                          >
                            {m.library_bangumi_label_new_name_input()}
                          </label>
                          <input
                            id={`bangumi-new-label-${ordinal}-${tag.index}`}
                            className="min-h-11 w-full rounded-md border bg-background px-3 py-2"
                            value={current.newNames[tag.index] ?? tag.proposedName ?? ''}
                            disabled={disabled || current.busy || held}
                            onChange={(event) =>
                              update((state) => ({
                                ...state,
                                newNames: { ...state.newNames, [tag.index]: event.target.value },
                              }))
                            }
                          />
                          <BangumiAction
                            type="button"
                            variant="outline"
                            disabled={
                              disabled ||
                              current.busy ||
                              held ||
                              !(current.newNames[tag.index] ?? tag.proposedName ?? '').length ||
                              (selectedCount >= 16 && !target)
                            }
                            onClick={() =>
                              update((state) => ({
                                ...state,
                                mappings: {
                                  ...state.mappings,
                                  [tag.index]: { name: state.newNames[tag.index] ?? tag.proposedName ?? '' },
                                },
                              }))
                            }
                          >
                            {m.library_bangumi_label_use_new_name({
                              name: current.newNames[tag.index] ?? tag.proposedName ?? '',
                            })}
                          </BangumiAction>
                          <label
                            className="block text-sm font-medium"
                            htmlFor={`bangumi-label-query-${ordinal}-${tag.index}`}
                          >
                            {m.library_bangumi_label_search_query()}
                          </label>
                          <input
                            id={`bangumi-label-query-${ordinal}-${tag.index}`}
                            className="min-h-11 w-full rounded-md border bg-background px-3 py-2"
                            value={query}
                            disabled={disabled || current.busy || held}
                            onChange={(event) =>
                              update((state) => ({
                                ...state,
                                queries: { ...state.queries, [tag.index]: event.target.value },
                              }))
                            }
                          />
                          <BangumiAction
                            type="button"
                            variant="outline"
                            disabled={disabled || current.busy || held || (selectedCount >= 16 && !target)}
                            onClick={() => void search(tag.index, query)}
                          >
                            {m.library_bangumi_label_search_owned()}
                          </BangumiAction>
                          {current.searchState[tag.index] === 'loaded' && current.options[tag.index]?.length === 0 ? (
                            <p>{m.library_bangumi_label_no_owned_labels()}</p>
                          ) : null}
                          {current.options[tag.index]?.length ? (
                            <ul className="space-y-2">
                              {current.options[tag.index]!.map((label) => (
                                <li key={label.id}>
                                  <BangumiAction
                                    type="button"
                                    variant="outline"
                                    disabled={disabled || current.busy || held || (selectedCount >= 16 && !target)}
                                    onClick={() =>
                                      update((state) => ({
                                        ...state,
                                        mappings: { ...state.mappings, [tag.index]: { labelId: label.id } },
                                      }))
                                    }
                                  >
                                    {m.library_bangumi_label_use_existing({
                                      name: label.name,
                                      revision: label.revision,
                                    })}
                                  </BangumiAction>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {current.searchState[tag.index] === 'unavailable' ? (
                            <p role="status">{m.library_bangumi_label_search_unavailable()}</p>
                          ) : null}
                        </div>
                      ) : (
                        <p>
                          {tag.status === 'invalid'
                            ? m.library_bangumi_label_tag_invalid()
                            : m.library_bangumi_label_tag_unknown()}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <p>{m.library_bangumi_label_selection_count({ selected: selectedCount, maximum: 16 })}</p>
          </div>
        ) : null}
        {current.mappings && Object.keys(current.mappings).length ? (
          <BangumiAction
            type="button"
            disabled={disabled || current.busy || held || !current.custody}
            onClick={() => void reviewLabels()}
          >
            {current.busy ? m.library_bangumi_label_reviewing() : m.library_bangumi_label_review_mapping()}
          </BangumiAction>
        ) : null}
        {current.labels ? (
          <section className="space-y-3 rounded-md border p-3" aria-labelledby={`bangumi-label-review-${ordinal}`}>
            <h5 id={`bangumi-label-review-${ordinal}`} className="font-medium">
              {m.library_bangumi_label_exact_review()}
            </h5>
            <p className="break-all text-sm">
              {m.library_bangumi_label_row_revision({ revision: current.labels.review.rowRevision })}
            </p>
            <p className="break-all text-sm">
              {m.library_bangumi_label_review_token({ token: current.labels.review.token })}
            </p>
            {current.labels.review.subject ? (
              <dl className="space-y-1 text-sm">
                <dt className="font-medium">{m.library_bangumi_label_subject_identity()}</dt>
                <dd className="break-all">
                  {current.labels.review.subject.subjectId} · {current.labels.review.subject.acceptingType} ·{' '}
                  {current.labels.review.subject.identityEpoch} ·{' '}
                  {current.labels.review.subject.releaseDigest ?? m.library_bangumi_label_profile_absent()}
                </dd>
              </dl>
            ) : (
              <p>{m.library_bangumi_label_subject_unavailable()}</p>
            )}
            <ul className="space-y-2">
              {current.labels.review.items.map((item) => (
                <li key={item.index} className="rounded border p-2" data-bangumi-label-review-index={item.index}>
                  <p>
                    {m.library_bangumi_label_tag_index({ index: item.index })}: {textValue(item.source)}
                  </p>
                  <p className="break-words">
                    {'labelId' in item.target
                      ? m.library_bangumi_label_review_existing({
                          id: item.target.labelId,
                          revision: item.target.revision,
                        })
                      : m.library_bangumi_label_review_new({ name: item.target.name })}
                  </p>
                  <p>{reviewItemLabel(item.status)}</p>
                </li>
              ))}
            </ul>
            <p>
              {current.labels.confirmed
                ? m.library_bangumi_label_confirmed()
                : m.library_bangumi_label_confirmation_needed()}
            </p>
            {!exactSelection && !current.labels.confirmed ? (
              <p role="status">{m.library_bangumi_label_mapping_changed_needs_review()}</p>
            ) : null}
            {!current.labels.confirmed ? (
              <BangumiAction
                type="button"
                disabled={disabled || current.busy || held || !current.labels.review.subject || !exactSelection}
                onClick={() => void applyLabels()}
              >
                {current.busy ? m.library_bangumi_label_applying() : m.library_bangumi_label_confirm_exact()}
              </BangumiAction>
            ) : null}
            {current.labels.confirmed && retryableResults ? (
              <BangumiAction
                type="button"
                disabled={disabled || current.busy || held}
                onClick={() => void applyLabels(undefined, true)}
              >
                {current.busy ? m.library_bangumi_label_applying() : m.library_bangumi_label_retry_failed()}
              </BangumiAction>
            ) : null}
          </section>
        ) : null}
        {outcomes.length ? (
          <section className="space-y-3" aria-label={m.library_bangumi_label_results()}>
            <h5 className="font-medium">{m.library_bangumi_label_results()}</h5>
            <ul className="space-y-2">
              {outcomes.map((outcome) => (
                <li
                  key={outcome.index}
                  className="space-y-1 rounded border p-3"
                  data-bangumi-label-outcome={outcome.status}
                >
                  <p>
                    {m.library_bangumi_label_tag_index({ index: outcome.index })}: {outcomeLabel(outcome.status)}
                  </p>
                  <p>
                    {m.library_bangumi_label_created({
                      created: outcome.created ? m.library_bangumi_label_yes() : m.library_bangumi_label_no(),
                    })}
                  </p>
                  {outcome.label ? (
                    <p className="break-all">
                      {m.library_bangumi_label_identity({ id: outcome.label.id, revision: outcome.label.revision })}
                    </p>
                  ) : null}
                  {outcome.assignment ? (
                    <p className="break-all">
                      {m.library_bangumi_label_assignment_identity({
                        id: outcome.assignment.id,
                        revision: outcome.assignment.revision,
                      })}
                    </p>
                  ) : null}
                  {outcome.created && !outcome.assignment ? (
                    <p role="status">{m.library_bangumi_label_incomplete_adoption()}</p>
                  ) : null}
                </li>
              ))}
            </ul>
            {current.result?.remaining.length ? (
              <p>{m.library_bangumi_label_remaining({ indices: current.result.remaining.join(', ') })}</p>
            ) : null}
          </section>
        ) : null}
        {current.labels?.review.subject ? (
          <section className="space-y-2 rounded-md border p-3">
            <h5 className="font-medium">{m.library_bangumi_label_current_assignments()}</h5>
            {current.assignmentState !== 'loaded' ? (
              <BangumiAction
                type="button"
                variant="outline"
                disabled={disabled || current.busy || held || current.assignmentState === 'loading'}
                onClick={() => void readAssignments(current.labels!.review.subject!.subjectId, rowRevision)}
              >
                {current.assignmentState === 'loading'
                  ? m.library_bangumi_label_assignments_loading()
                  : m.library_bangumi_label_read_assignments()}
              </BangumiAction>
            ) : null}
            {current.assignmentState === 'unavailable' ? (
              <p role="status">{m.library_bangumi_label_assignments_unavailable()}</p>
            ) : null}
            {current.assignments ? (
              current.assignments.length ? (
                <ul className="space-y-1">
                  {current.assignments.map((assignment) => (
                    <li key={assignment.id} className="break-all">
                      {assignment.name} · {assignment.labelId} · {assignment.id} · {assignment.revision}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{m.library_bangumi_label_no_current_assignments()}</p>
              )
            ) : null}
          </section>
        ) : null}
      </div>
    </details>
  );
}

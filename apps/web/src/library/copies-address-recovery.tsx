import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { copiesSubjectId, type CopiesAddress } from './copies-query';

/** Read-only GET navigation: correction never submits or changes a copy command. */
export function CopiesAddressRecovery({ address, current }: { address: CopiesAddress; current: () => boolean }) {
  const field = useId();
  const subjectIssue = address.issue === 'subject';
  const kindIssue = address.issue === 'kind';
  const statusIssue = address.issue === 'status';
  const filterIssue = kindIssue || statusIssue;
  const path = `/${address.locale}/library/copies`;
  const restart = new URLSearchParams();
  if (!subjectIssue && address.subjectId) restart.set('subjectId', address.subjectId);
  if (!kindIssue && address.kind) restart.set('kind', address.kind);
  if (!statusIssue && address.status) restart.set('status', address.status);
  const firstPage = path + (restart.size ? `?${restart}` : '');
  const fieldName = subjectIssue ? 'subjectId' : kindIssue ? 'kind' : statusIssue ? 'status' : 'cursor';
  const filterValue = kindIssue ? address.kind : address.status;
  const fieldValue = subjectIssue
    ? (address.subjectId?.length ?? 0) <= 128
      ? (address.subjectId ?? '')
      : ''
    : filterIssue && (filterValue?.length ?? 0) <= 128
      ? (filterValue ?? '')
      : '';
  const validFilter = (value: string) => /^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/.test(value);
  const control = 'min-h-11 rounded-lg border border-border px-4 py-2';
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <PageHeading>{m.library_copy_heading()}</PageHeading>
      <p role="alert">
        {subjectIssue
          ? m.library_copies_address_subject_invalid()
          : filterIssue
            ? m.library_copies_address_filter_invalid()
            : m.library_copies_address_cursor_invalid()}
      </p>
      <form
        method="get"
        action={path}
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          if (!current()) event.preventDefault();
        }}
      >
        {!subjectIssue && address.subjectId ? <input type="hidden" name="subjectId" value={address.subjectId} /> : null}
        {!kindIssue && address.kind ? <input type="hidden" name="kind" value={address.kind} /> : null}
        {!statusIssue && address.status ? <input type="hidden" name="status" value={address.status} /> : null}
        <label htmlFor={field}>
          {subjectIssue
            ? m.library_copies_address_subject_label()
            : filterIssue
              ? m.library_copies_address_filter_label()
              : m.library_copies_address_cursor_label()}
        </label>
        <input
          id={field}
          name={fieldName}
          defaultValue={fieldValue}
          required
          maxLength={subjectIssue ? 36 : filterIssue ? 64 : 2048}
          pattern={
            subjectIssue
              ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
              : filterIssue
                ? '[a-z][a-z0-9_.-]{0,63}'
                : undefined
          }
          autoComplete="off"
          className={`${control} w-full`}
          onChange={(event) => {
            event.currentTarget.setCustomValidity(
              subjectIssue
                ? !copiesSubjectId(event.currentTarget.value)
                  ? m.library_copies_address_subject_invalid()
                  : ''
                : filterIssue && !validFilter(event.currentTarget.value)
                  ? m.library_copies_address_filter_invalid()
                  : '',
            );
          }}
        />
        <button type="submit" className={control}>
          {m.library_copies_address_correct()}
        </button>
      </form>
      <nav aria-label={m.library_copies_address_recovery()} className="flex flex-wrap gap-3">
        <a
          href={firstPage}
          className={control}
          onClick={(event) => {
            if (!current()) event.preventDefault();
          }}
        >
          {subjectIssue ? m.library_copies_address_clear() : m.library_copies_address_restart()}
        </a>
      </nav>
    </div>
  );
}

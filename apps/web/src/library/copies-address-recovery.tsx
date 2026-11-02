import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { copiesSubjectId, type CopiesAddress } from './copies-query';

/** Read-only GET navigation: correction never submits or changes a copy command. */
export function CopiesAddressRecovery({ address, current }: { address: CopiesAddress; current: () => boolean }) {
  const field = useId();
  const subjectIssue = address.issue === 'subject';
  const path = `/${address.locale}/library/copies`;
  const restart = new URLSearchParams();
  if (!subjectIssue && address.subjectId) restart.set('subjectId', address.subjectId);
  const firstPage = path + (restart.size ? `?${restart}` : '');
  const control = 'min-h-11 rounded-lg border border-border px-4 py-2';
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <PageHeading>{m.library_copy_heading()}</PageHeading>
      <p role="alert">
        {subjectIssue ? m.library_copies_address_subject_invalid() : m.library_copies_address_cursor_invalid()}
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
        <label htmlFor={field}>
          {subjectIssue ? m.library_copies_address_subject_label() : m.library_copies_address_cursor_label()}
        </label>
        <input
          id={field}
          name={subjectIssue ? 'subjectId' : 'cursor'}
          defaultValue={subjectIssue && (address.subjectId?.length ?? 0) <= 128 ? (address.subjectId ?? '') : ''}
          required
          maxLength={subjectIssue ? 36 : 2048}
          pattern={
            subjectIssue
              ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
              : undefined
          }
          autoComplete="off"
          className={`${control} w-full`}
          onChange={(event) => {
            event.currentTarget.setCustomValidity(
              subjectIssue && !copiesSubjectId(event.currentTarget.value)
                ? m.library_copies_address_subject_invalid()
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

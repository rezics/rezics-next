import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { CollectionRuleCurrent } from '../collection-rule-current';
import type { RulePage } from '../collection-rule-read';
import { savedQueryCreateHref, type SavedQuerySelection } from './selection';

/** Review a carried selection, then the existing rule editor. Invalid selections never POST. */
export function SavedQueryEditor({
  page,
  collectionId,
  selection,
  originHref,
  navigate,
}: {
  page: RulePage;
  collectionId: string | null;
  selection: SavedQuerySelection;
  originHref?: string | null;
  navigate?: (id: string) => void;
}) {
  if (collectionId === null && selection.state === 'invalid')
    return <SavedQueryCorrection selection={selection} originHref={originHref ?? null} />;
  return (
    <CollectionRuleCurrent
      page={page}
      collectionId={collectionId}
      {...(collectionId === null && selection.state === 'admitted' ? { seed: selection.filter } : {})}
      {...(navigate ? { navigate } : {})}
    />
  );
}

function SavedQueryCorrection({
  selection,
  originHref,
}: {
  selection: Extract<SavedQuerySelection, { state: 'invalid' }>;
  originHref: string | null;
}) {
  const locale = getLocale();
  const stateIssue = selection.issues.some((issue) => issue.key === 'state');
  return (
    <article className="flex min-w-0 max-w-4xl flex-col gap-4 text-foreground">
      <PageHeading>{m.library_rule_new()}</PageHeading>
      <div role="alert" className="flex min-w-0 flex-col gap-3">
        <p>{m.library_saved_query_invalid()}</p>
        {stateIssue ? <p>{m.library_saved_query_state()}</p> : null}
        <ul>
          {selection.issues.map((issue) => (
            <li key={issue.key}>
              <code>{issue.key}</code>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3">
          {originHref ? (
            <a className="inline-flex min-h-11 items-center rounded-lg border border-border px-4" href={originHref}>
              {m.library_saved_query_correct()}
            </a>
          ) : null}
          <a
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4"
            href={savedQueryCreateHref(locale, {})}
          >
            {m.library_saved_query_blank()}
          </a>
        </div>
      </div>
    </article>
  );
}

import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { ExactDocument, StudioPresentation, StudioRevision } from './contract';
import type { StudioController, StudioState } from './controller';

export function ExactVersionDetails({ exact }: { exact: ExactDocument }) {
  const options = { locale: getLocale() };
  return (
    <details className="studio-technical">
      <summary>{m.studio_revision_exact({}, options)}</summary>
      <dl>
        <dt>{m.studio_revision_post({}, options)}</dt>
        <dd>{exact.postId}</dd>
        <dt>{m.studio_revision_id({}, options)}</dt>
        <dd>{exact.revisionId}</dd>
        <dt>{m.studio_revision_digest({}, options)}</dt>
        <dd>{exact.sha256}</dd>
      </dl>
    </details>
  );
}
export function RevisionBody({
  revision,
  presentation,
}: {
  revision: StudioRevision;
  presentation: StudioPresentation;
}) {
  const options = { locale: getLocale() };
  const title = revision.title.trim() || m.own_drafts_no_title({}, options);
  return (
    <section className="studio-revision-body" aria-label={m.studio_revision_saved_name({ title }, options)}>
      <h3>{title}</h3>
      <p className="studio-help">
        <time dateTime={revision.savedAt}>{m.studio_revision_saved({ savedAt: revision.savedAt }, options)}</time>
      </p>
      <ExactVersionDetails exact={revision.exact} />
      <DocumentBody
        {...presentation.reader?.(revision.exact)}
        document={revision.body}
        visitKey={`${revision.exact.postId}:${revision.exact.revisionId}:${revision.exact.sha256}`}
      />
    </section>
  );
}
export function StudioVersions({
  controller,
  state,
  presentation,
}: {
  controller: StudioController;
  state: StudioState;
  presentation: StudioPresentation;
}) {
  const [restore, setRestore] = useState(false);
  const options = { locale: getLocale() };
  const selected = state.selected;
  if (!selected) return null;
  const blocked = Boolean(state.busy) || controller.hasUnresolvedCommand();
  const historical = state.historical;
  return (
    <section className="studio-stack" aria-label={m.studio_revision_region({}, options)}>
      <div className="studio-section-heading">
        <h2>{m.studio_revision_heading({}, options)}</h2>
        <Button type="button" variant="outline" disabled={blocked} onClick={() => void controller.loadVersions()}>
          {m.studio_revision_refresh({}, options)}
        </Button>
      </div>
      <p className="studio-help">{m.studio_revision_intro({}, options)}</p>
      {state.versions ? (
        <>
          <ol className="studio-version-list">
            {state.versions.items.map((version) => (
              <li key={version.exact.revisionId}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={blocked}
                  aria-pressed={historical?.exact.revisionId === version.exact.revisionId}
                  onClick={() => {
                    setRestore(false);
                    void controller.inspectVersion(version.exact);
                  }}
                >
                  {m.studio_revision_compare({ savedAt: version.savedAt }, options)}
                </Button>
                <ExactVersionDetails exact={version.exact} />
              </li>
            ))}
          </ol>
          {!state.versions.items.length ? (
            <p>
              {state.versions.nextCursor
                ? m.thread_history_page_empty({}, options)
                : m.thread_history_empty({}, options)}
            </p>
          ) : null}
          {state.versions.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              disabled={blocked}
              onClick={() => void controller.loadVersions(true)}
            >
              {m.thread_history_more({}, options)}
            </Button>
          ) : null}
        </>
      ) : (
        <Button type="button" variant="outline" disabled={blocked} onClick={() => void controller.loadVersions()}>
          {m.studio_revision_load({}, options)}
        </Button>
      )}
      {historical ? (
        <>
          <div className="studio-comparison">
            <div>
              <h3>{m.studio_revision_selected({}, options)}</h3>
              <RevisionBody revision={historical} presentation={presentation} />
            </div>
            <div>
              <h3>{m.studio_revision_current({}, options)}</h3>
              <RevisionBody revision={selected.source.revision} presentation={presentation} />
            </div>
          </div>
          {selected.dirty ? <p className="studio-help">{m.studio_revision_unsaved({}, options)}</p> : null}
          {selected.source.permissions.edit ? (
            restore ? (
              <div role="group" aria-label={m.studio_revision_copy_review({}, options)} className="studio-stack">
                <p>
                  {selected.dirty
                    ? m.studio_revision_replace_dirty({ title: historical.title, savedAt: historical.savedAt }, options)
                    : m.studio_revision_replace_clean(
                        { title: historical.title, savedAt: historical.savedAt },
                        options,
                      )}
                </p>
                <div className="studio-action-row">
                  <Button
                    type="button"
                    disabled={blocked || selected.snapshotPending || selected.uploading}
                    onClick={() => {
                      controller.restoreVersion();
                      setRestore(false);
                    }}
                  >
                    {m.studio_revision_copy({}, options)}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setRestore(false)}>
                    {m.action_cancel({}, options)}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={blocked || selected.snapshotPending || selected.uploading}
                onClick={() => setRestore(true)}
              >
                {m.studio_revision_use({}, options)}
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}

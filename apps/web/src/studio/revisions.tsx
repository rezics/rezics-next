import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import type { ExactDocument, StudioPresentation, StudioRevision } from './contract';
import type { StudioController, StudioState } from './controller';

export function ExactVersionDetails({ exact }: { exact: ExactDocument }) {
  return <details className="studio-technical">
    <summary>Exact document version</summary>
    <dl><dt>Post</dt><dd>{exact.postId}</dd><dt>Revision</dt><dd>{exact.revisionId}</dd><dt>SHA-256</dt><dd>{exact.sha256}</dd></dl>
  </details>;
}
export function RevisionBody({ revision, presentation }: { revision: StudioRevision; presentation: StudioPresentation }) {
  return <section className="studio-revision-body" aria-label={`${revision.title}, exact saved version`}>
    <h3>{revision.title}</h3>
    <p className="studio-help">Saved <time dateTime={revision.savedAt}>{revision.savedAt}</time></p>
    <ExactVersionDetails exact={revision.exact} />
    <DocumentBody {...presentation.reader?.(revision.exact)} document={revision.body}
      visitKey={`${revision.exact.postId}:${revision.exact.revisionId}:${revision.exact.sha256}`} />
  </section>;
}
export function StudioVersions({ controller, state, presentation }: {
  controller: StudioController;
  state: StudioState;
  presentation: StudioPresentation;
}) {
  const [restore, setRestore] = useState(false);
  const selected = state.selected;
  if (!selected) return null;
  const blocked = Boolean(state.busy) || controller.hasUnresolvedCommand();
  const historical = state.historical;
  return <section className="studio-stack" aria-label="Document versions">
    <div className="studio-section-heading"><h2>Versions</h2>
      <Button type="button" variant="outline" disabled={blocked} onClick={() => void controller.loadVersions()}>Refresh versions</Button>
    </div>
    <p className="studio-help">Compare exact saved revisions. Copying a version into the editor creates a working draft; publishing is a separate action.</p>
    {state.versions ? <>
      <ol className="studio-version-list">
        {state.versions.items.map((version) => <li key={version.exact.revisionId}>
          <Button type="button" variant="outline" disabled={blocked}
            aria-pressed={historical?.exact.revisionId === version.exact.revisionId}
            onClick={() => { setRestore(false); void controller.inspectVersion(version.exact); }}>
            Compare {version.savedAt}
          </Button>
          <span className="studio-break">{version.exact.revisionId}</span>
        </li>)}
      </ol>
      {!state.versions.items.length ? <p>No earlier versions are available.</p> : null}
      {state.versions.nextCursor ? <Button type="button" variant="outline" disabled={blocked}
        onClick={() => void controller.loadVersions(true)}>Next versions</Button> : null}
    </> : <Button type="button" variant="outline" disabled={blocked} onClick={() => void controller.loadVersions()}>Load saved versions</Button>}
    {historical ? <>
      <div className="studio-comparison">
        <div><h3>Selected version</h3><RevisionBody revision={historical} presentation={presentation} /></div>
        <div><h3>Current saved draft</h3><RevisionBody revision={selected.source.revision} presentation={presentation} /></div>
      </div>
      {selected.dirty ? <p className="studio-help">The editor also contains unsaved changes.</p> : null}
      {selected.source.permissions.edit ? restore ? <div role="group" aria-label="Copy version into draft" className="studio-stack">
        <p>Replace the working text with this version{selected.dirty ? ' and discard unsaved changes' : ''}?</p>
        <div className="studio-action-row">
          <Button type="button" disabled={blocked || selected.snapshotPending || selected.uploading} onClick={() => {
            controller.restoreVersion(); setRestore(false);
          }}>Copy into working draft</Button>
          <Button type="button" variant="outline" onClick={() => setRestore(false)}>Cancel</Button>
        </div>
      </div> : <Button type="button" variant="outline" disabled={blocked || selected.snapshotPending || selected.uploading}
        onClick={() => setRestore(true)}>Use this version…</Button> : null}
    </> : null}
  </section>;
}

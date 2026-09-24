import type { work as EnglishWork } from '../../i18n/en.ts';

export interface WorkRevisionDetail {
  work: string;
  title: string;
  language: string;
  mainVersion: string;
  operation: string;
  sourcePosition: { sequence: string };
}

export function WorkDetail({ work, revision, messages }: { work: WorkRevisionDetail; revision: string;
  messages: typeof EnglishWork }) {
  return <main className="page-width">
    <section className="work-heading"><div><h1 className="page-title">{work.title}</h1>
      <p className="byline">{messages.exactRevision} · {work.language.toUpperCase()}</p></div>
      <div className="perspective-box"><p className="perspective-label">{messages.perspective}</p>
        <p className="perspective-value">{messages.globalPerspective}</p>
        <p>{messages.perspectiveHelp}</p></div></section>
    <div className="work-tabs"><span>{messages.mainVersion}</span></div>
    <div className="work-layout"><article className="work-main"><h2>{messages.selectedVersion}</h2>
      <p>{work.title}</p><p className="muted">{messages.metadataPrefix}{revision}{messages.metadataSuffix}</p>
    </article><aside className="work-aside"><h2>{messages.revisionDetails}</h2>
      <dl className="detail-list"><dt>{messages.work}</dt><dd>{work.work}</dd>
        <dt>{messages.mainVersion}</dt><dd>{work.mainVersion}</dd>
        <dt>{messages.operation}</dt><dd>{work.operation}</dd>
        <dt>{messages.language}</dt><dd>{work.language}</dd>
        <dt>{messages.sequence}</dt><dd>{work.sourcePosition.sequence}</dd></dl>
    </aside></div>
  </main>;
}

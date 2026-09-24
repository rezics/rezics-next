export interface WorkRevisionDetail {
  work: string;
  title: string;
  language: string;
  mainVersion: string;
  operation: string;
  sourcePosition: { sequence: string };
}

export function WorkDetail({ work, revision }: { work: WorkRevisionDetail; revision: string }) {
  return <main className="page-width">
    <section className="work-heading"><div><h1 className="page-title">{work.title}</h1>
      <p className="byline">Exact revision · {work.language.toUpperCase()}</p></div>
      <div className="perspective-box"><p className="perspective-label">Perspective</p>
        <p className="perspective-value">Global perspective</p>
        <p>This exact revision follows the Main Version record.</p></div></section>
    <div className="work-tabs"><span>Main Version</span></div>
    <div className="work-layout"><article className="work-main"><h2>Selected version</h2>
      <p>{work.title}</p><p className="muted">This exact metadata revision is retained as {revision}.</p>
    </article><aside className="work-aside"><h2>Revision details</h2>
      <dl className="detail-list"><dt>Work</dt><dd>{work.work}</dd>
        <dt>Main Version</dt><dd>{work.mainVersion}</dd>
        <dt>Operation</dt><dd>{work.operation}</dd>
        <dt>Language</dt><dd>{work.language}</dd>
        <dt>Sequence</dt><dd>{work.sourcePosition.sequence}</dd></dl>
    </aside></div>
  </main>;
}

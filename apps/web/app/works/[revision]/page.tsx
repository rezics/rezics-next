import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { serviceOrigin } from '../../../features/api/origins.ts';

export default async function WorkRevisionPage({ params }: { params: Promise<{ revision: string }> }) {
  const { revision } = await params;
  if (!/^[0-9a-f-]{36}$/.test(revision)) notFound();
  const jar = await cookies();
  const token = jar.get('rezics_access')?.value;
  const subject = jar.get('rezics_subject')?.value;
  if (!token || !subject) redirect(`/sign-in?next=${encodeURIComponent(`/works/${revision}`)}`);
  const main = treaty<MainApp>(serviceOrigin('MAIN_ORIGIN'));
  const response = await main.v1.revisions({ revision }).get({ query: { actingSubject: subject },
    headers: { authorization: `Bearer ${token}` }, fetch: { cache: 'no-store' } });
  if (response.error?.status === 404) notFound();
  if (response.error || !response.data) {
    return <main className="page-width"><p className="state-panel" role="alert">
      This revision is unavailable. Your access or the source service may have changed.
    </p></main>;
  }
  const work = response.data;
  return <main className="page-width">
    <section className="work-heading"><div><h1 className="page-title">{work.title}</h1>
      <p className="byline">Exact revision · {work.language.toUpperCase()}</p></div>
      <div className="perspective-box"><label htmlFor="work-perspective">View this work from a perspective</label>
        <select className="select-control" id="work-perspective" disabled value="global"><option value="global">Global perspective</option></select>
        <p>This revision is shown from the Main Version record.</p></div></section>
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

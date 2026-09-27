import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region } from './region.tsx';
import { idOf } from './route.ts';
import type { WorkHeader } from './types.ts';

function Identifier({ term, value, href }: { term: string; value: string; href?: string }) {
  return <div className="grid gap-0.5">
    <dt className="text-muted-foreground text-xs">{term}</dt>
    <dd className="break-all font-mono text-[13px]">
      {href ? <Link href={href} className="text-primary underline-offset-4 hover:underline">{value}</Link> : value}</dd>
  </div>;
}

/** The exact identities this view was read from, and the graph position it reflects. */
export function WorkRecord({ work, locale, messages }: { work: WorkHeader; locale: UiLocale; messages: WorkPageMessages }) {
  const t = materializeData(messages, { locale });
  const revision = idOf(work.revision);
  return <Region id="work-record" title={t.record}>
    <dl className="grid gap-3">
      <Identifier term={t.workId} value={work.id} />
      <Identifier term={t.mainVersionId} value={work.mainVersion} />
      <Identifier term={t.headRevision} value={work.revision}
        href={revision ? `/works/${revision}` : undefined} />
      {work.metadataRevision ? <Identifier term={t.metadataRevision} value={work.metadataRevision} /> : null}
    </dl>
    <p className="text-muted-foreground text-xs">{t.asOf({ sequence: work.sourcePosition.sequence })}</p>
  </Region>;
}

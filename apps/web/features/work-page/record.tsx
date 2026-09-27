import { Clipboard, ClipboardIndicator, ClipboardTrigger, ClipboardValue } from '@rezics/ui/clipboard';
import { buttonVariants } from '@rezics/ui/button';
import { ChevronDownIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { languageName, typeNames } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { idOf } from './route.ts';
import type { WorkHeader } from './types.ts';

function Fact({ term, value, href, mono = false, lang }: {
  term: string; value: string; href?: string; mono?: boolean; lang?: string;
}) {
  return <div className="grid min-w-0 gap-0.5">
    <dt className="text-muted-foreground text-xs">{term}</dt>
    <dd lang={lang} className={mono ? 'break-all font-mono text-[13px]' : 'text-sm'}>
      {href ? <Link href={href} className="text-primary underline-offset-4 hover:underline">{value}</Link> : value}</dd>
  </div>;
}

/**
 * The model behind the page, folded away as Goodreads folds "Book details &
 * editions": kind, Main Version, the exact identities this view was read
 * from and the graph position it reflects, and a citation to copy.
 */
export function WorkRecord({ work, citation, locale, messages }: {
  work: WorkHeader; citation?: string; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const revision = idOf(work.revision);
  const types = typeNames(work.types, t);
  return <details className="group min-w-0 border-border/70 border-y">
    <summary className="flex cursor-pointer list-none items-center gap-2 py-4 font-semibold outline-none
      focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {t.record}<ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-6 pb-6">
      <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {types.length ? <Fact term={t.workType} value={types.join(', ')} /> : null}
        {work.selectedLanguage ? <Fact term={t.mainVersionLanguage} value={languageName(work.selectedLanguage, locale)} />
          : null}
        {work.mainVersionLabel ? <Fact term={t.mainVersion} value={work.mainVersionLabel.value}
          lang={work.mainVersionLabel.language} /> : null}
        {work.originalTitle ? <Fact term={t.originalTitle} value={work.originalTitle.value}
          lang={work.originalTitle.language} /> : null}
        <Fact term={t.workId} value={work.id} mono />
        <Fact term={t.mainVersionId} value={work.mainVersion} mono />
        <Fact term={t.headRevision} value={work.revision} mono href={revision ? `/works/${revision}` : undefined} />
        {work.metadataRevision ? <Fact term={t.metadataRevision} value={work.metadataRevision} mono /> : null}
      </dl>
      <p className="text-muted-foreground text-xs">{t.asOf({ sequence: work.sourcePosition.sequence })}</p>
      {citation ? <Clipboard value={citation} label={t.cite} className="flex-col items-stretch sm:flex-row">
        <ClipboardValue className="h-auto min-h-9 flex-1 whitespace-normal py-2 text-sm" />
        <ClipboardTrigger aria-label={t.copyCitation} className={buttonVariants({ variant: 'outline', size: 'md' })}>
          <ClipboardIndicator copied={t.copied}>{t.copyCitation}</ClipboardIndicator>
        </ClipboardTrigger>
      </Clipboard> : null}
    </div>
  </details>;
}

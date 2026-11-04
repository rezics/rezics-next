import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { languageName } from '../../../subject/language';
import { m } from '../../../paraglide/messages.js';
import type { WorkNames } from './model';

export function WorkNamesView({ names, locale, retired = false, sourcesHref }: {
  names: WorkNames; locale: string; retired?: boolean; sourcesHref: string;
}) {
  const options = { locale: locale as never };
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <section className="min-w-0 space-y-3 [overflow-wrap:anywhere]" aria-label={m.work_names_title({}, options)}>
    <details>
      <summary className="cursor-pointer font-medium">{m.work_names_title({}, options)}</summary>
      {retired || names.state === 'unavailable' ? <p role="status">{m.work_names_unavailable({}, options)}</p> : <div className="space-y-3 py-3">
        {names.selected.text && <p>{names.selected.lang && names.selected.lang !== locale
          ? m.work_names_fallback({}, options) : m.work_names_selected({}, options)}{' '}
          <span lang={names.selected.lang ?? locale} dir="auto">{names.selected.text}</span>
        </p>}
        <p>{m.work_names_original({}, options)}{' '}{names.originalLanguage
          ? languageName(names.originalLanguage, locale) ?? names.originalLanguage
          : m.work_names_unknown({}, options)}
          {names.original && <>: <span lang={names.original.lang} dir="auto">{names.original.text}</span></>}
        </p>
        {names.groups.length === 0 && <p>{m.work_names_empty({}, options)}</p>}
        {names.groups.map((group) => <details key={group.language}>
          <summary className="cursor-pointer">{languageName(group.language, locale) ?? group.language}</summary>
          <ul className="space-y-2 py-2">
            {group.names.map((name) => <li key={name.text} className="flex min-w-0 flex-wrap items-start gap-2">
              <span className="min-w-0 flex-1" lang={group.language} dir="auto">{name.text}</span>
              <span className="text-muted-foreground text-sm">{name.roles.map((role) => role === 'title'
                ? m.work_names_label({}, options) : m.work_names_alias({}, options)).join(' · ')}</span>
              <Button size="sm" variant="outline" onClick={async () => {
                try { await navigator.clipboard.writeText(name.text); setCopyState('copied'); }
                catch { setCopyState('failed'); }
              }}>{m.work_names_copy({}, options)}</Button>
            </li>)}
          </ul>
        </details>)}
        <p role="status">{copyState === 'copied' ? m.work_names_copied({}, options)
          : copyState === 'failed' ? m.work_names_copy_failed({}, options) : ''}</p>
        <a className="text-primary underline" href={sourcesHref}>{m.work_names_sources({}, options)}</a>
      </div>}
    </details>
  </section>;
}

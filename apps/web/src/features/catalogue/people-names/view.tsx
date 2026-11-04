import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../../paraglide/messages.js';
import { languageName } from '../../../subject/language';
import { PlainLink, type PageLink } from '../../pages/shared';
import type { NamesWindow } from '../work-names/navigation';
import type { WorkNameGroup } from '../work-names/model';
import {
  filterPeopleNames,
  PEOPLE_NAME_FILTER_LENGTH,
  PEOPLE_NAME_GROUP_WINDOW,
  PEOPLE_NAME_ROW_WINDOW,
  type NamesAdvice,
  type PeopleNames,
} from './model';

const control =
  'inline-flex min-h-11 min-w-11 items-center rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const live = () => true;

export function PeopleNamesView({
  names,
  locale,
  retired = false,
  current = live,
  advice,
  retryAdvice,
  sourcesHref,
  termsHref,
  link: Link = PlainLink,
  restored,
  kind = 'people',
  metadata,
}: {
  names: PeopleNames;
  locale: string;
  retired?: boolean;
  current?: () => boolean;
  advice: NamesAdvice;
  retryAdvice?: (() => void) | undefined;
  sourcesHref: string;
  termsHref: string;
  link?: PageLink;
  restored?: NamesWindow | undefined;
  kind?: 'people' | 'work';
  metadata?: ReactNode;
}) {
  const o = { locale: locale as never };
  const id = useId();
  const filter = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [query, setQuery] = useState(restored?.query ?? '');
  const [page, setPage] = useState(restored?.page ?? 0);
  const groups = useMemo(() => (names.state === 'ready' ? filterPeopleNames(names.groups, query) : []), [names, query]);
  const count = groups.reduce((sum, group) => sum + group.names.length, 0);
  const offset = Math.min(page, Math.max(0, Math.ceil(groups.length / PEOPLE_NAME_GROUP_WINDOW) - 1)) * PEOPLE_NAME_GROUP_WINDOW;
  return (
    <section id="supplied-names" data-slot="supplied-names" className="min-w-0 space-y-3 [overflow-wrap:anywhere]" data-names-page={offset / PEOPLE_NAME_GROUP_WINDOW}>
      {kind === 'people' && <h3 className="text-xl font-semibold">{m.people_names_heading({}, o)}</h3>}
      {!retired && names.state === 'ready' && names.selected.text && (
        <p className="text-sm text-muted-foreground">
          {names.selected.lang && names.selected.lang !== locale
            ? (kind === 'work' ? m.work_names_fallback({}, o) : m.people_names_fallback({}, o))
            : (kind === 'work' ? m.work_names_selected({}, o) : m.people_names_selected({}, o))}{' '}
          <span lang={names.selected.lang ?? locale} dir="auto">
            {names.selected.text}
          </span>
        </p>
      )}
      <details open={restored?.expanded}>
        <summary ref={summary} className={control}>
          {kind === 'work' ? m.work_names_title({}, o) : m.people_names_open({}, o)}
        </summary>
        {retired ? (
          <p role="status">{m.people_names_retired({}, o)}</p>
        ) : names.state !== 'ready' ? (
          <p role="status">
            {names.state === 'oversized' ? m.people_names_oversized({}, o) : m.people_names_malformed({}, o)}
          </p>
        ) : (
          <div className="min-w-0 space-y-4 py-3">
            {metadata}
            {names.groups.length === 0 ? (
              <p>{m.people_names_empty({}, o)}</p>
            ) : (
              <>
                <div className="space-y-2">
                  <label htmlFor={id} className="font-medium">
                    {m.people_names_filter({}, o)}
                  </label>
                  <p id={`${id}-scope`} className="text-sm text-muted-foreground">
                    {m.people_names_scope({}, o)}
                  </p>
                  <Input
                    id={id}
                    ref={filter}
                    value={query}
                    maxLength={PEOPLE_NAME_FILTER_LENGTH}
                    aria-describedby={`${id}-scope`}
                    type="search"
                    onChange={(event) => {
                      setQuery(event.target.value.slice(0, PEOPLE_NAME_FILTER_LENGTH));
                      setPage(0);
                    }}
                  />
                  {query && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQuery('');
                        setPage(0);
                        filter.current?.focus();
                      }}
                    >
                      {m.people_names_reset({}, o)}
                    </Button>
                  )}
                </div>
                <p role="status">{m.people_names_count({ count }, o)}</p>
                {groups.length === 0 ? (
                  <p>{m.people_names_no_match({}, o)}</p>
                ) : (
                  <>
                    <div className="space-y-3" key={query}>
                      {groups.slice(offset, offset + PEOPLE_NAME_GROUP_WINDOW).map((group, index) => (
                        <NameGroup key={group.language} group={group} locale={locale} current={current} index={offset + index} restored={restored?.groups.find(g => g.index === offset + index)} />
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <p>
                        {m.people_names_groups(
                          {
                            start: offset + 1,
                            end: Math.min(offset + PEOPLE_NAME_GROUP_WINDOW, groups.length),
                            total: groups.length,
                          },
                          o,
                        )}
                      </p>
                      {page > 0 && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setPage((value) => value - 1);
                            summary.current?.focus();
                          }}
                        >
                          {m.people_names_previous({}, o)}
                        </Button>
                      )}
                      {offset + PEOPLE_NAME_GROUP_WINDOW < groups.length && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setPage((value) => value + 1);
                            summary.current?.focus();
                          }}
                        >
                          {m.people_names_next({}, o)}
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </details>
      {!retired && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {advice === 'signed-out'
              ? m.people_names_signed_out({}, o)
              : advice === 'pending'
                ? m.people_names_advice_pending({}, o)
                : advice === 'unavailable'
                  ? m.people_names_advice_unavailable({}, o)
                  : advice === 'denied'
                    ? m.people_names_advice_denied({}, o)
                    : m.people_names_advice_allowed({}, o)}
          </p>
          <div className="flex flex-wrap gap-3">
            {advice === 'unavailable' && retryAdvice && (
              <Button variant="outline" onClick={retryAdvice}>
                {m.people_names_retry({}, o)}
              </Button>
            )}
            <span data-names-terms>
              <Link href={termsHref} className={control}>{m.catalogue_terms_title({}, o)}</Link>
            </span>
            <Link href={sourcesHref} className={control}>
              {m.work_names_sources({}, o)}
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

function NameGroup({ group, locale, current, index, restored }: { group: WorkNameGroup; locale: string; current: () => boolean; index: number; restored?: NamesWindow['groups'][number] | undefined }) {
  const o = { locale: locale as never };
  const summary = useRef<HTMLElement>(null);
  const [page, setPage] = useState(restored?.page ?? 0);
  const offset = Math.min(page, Math.max(0, Math.ceil(group.names.length / PEOPLE_NAME_ROW_WINDOW) - 1)) * PEOPLE_NAME_ROW_WINDOW;
  return (
    <details className="min-w-0 rounded-md border border-border p-3" data-name-language={group.language} data-name-index={index} data-name-page={offset / PEOPLE_NAME_ROW_WINDOW} open={restored?.open}>
      <summary ref={summary} className={control}>
        <span lang={group.language} dir="auto">
          {languageName(group.language, group.language) ?? group.language}
        </span>
      </summary>
      <ul className="space-y-3 py-3" lang={group.language} dir="auto">
        {group.names.slice(offset, offset + PEOPLE_NAME_ROW_WINDOW).map((name) => (
          <li key={name.text} className="min-w-0 space-y-1">
            <span className="block min-w-0 whitespace-pre-wrap" data-supplied-name>
              {name.text}
            </span>
            <span className="text-sm text-muted-foreground" lang={locale} dir="auto">
              {name.roles
                .map((role) => (role === 'title' ? m.people_names_label({}, o) : m.work_names_alias({}, o)))
                .join(' · ')}
            </span>{' '}
            <CopyName text={name.text} locale={locale} current={current} />
          </li>
        ))}
      </ul>
      {group.names.length > PEOPLE_NAME_ROW_WINDOW && (
        <div className="flex flex-wrap items-center gap-3" lang={locale} dir="auto">
          <p>
            {m.people_names_rows(
              {
                start: offset + 1,
                end: Math.min(offset + PEOPLE_NAME_ROW_WINDOW, group.names.length),
                total: group.names.length,
              },
              o,
            )}
          </p>
          {page > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setPage((value) => value - 1);
                summary.current?.focus();
              }}
            >
              {m.people_names_previous({}, o)}
            </Button>
          )}
          {offset + PEOPLE_NAME_ROW_WINDOW < group.names.length && (
            <Button
              variant="outline"
              onClick={() => {
                setPage((value) => value + 1);
                summary.current?.focus();
              }}
            >
              {m.people_names_more({}, o)}
            </Button>
          )}
        </div>
      )}
    </details>
  );
}

function CopyName({ text, locale, current }: { text: string; locale: string; current: () => boolean }) {
  const o = { locale: locale as never };
  const id = useId();
  const [status, setStatus] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const busy = useRef(false);
  const control = useRef<HTMLButtonElement>(null);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2" lang={locale} dir="auto">
      <Button
        ref={control}
        size="sm"
        variant="outline"
        aria-describedby={id}
        aria-busy={status === 'pending'}
        onClick={async () => {
          if (busy.current || !current()) return;
          busy.current = true;
          setStatus('pending');
          let next: 'copied' | 'failed' = 'copied';
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            next = 'failed';
          }
          busy.current = false;
          if (current() && control.current?.isConnected) setStatus(next);
        }}
      >
        {m.work_names_copy({}, o)}
      </Button>
      <span id={id} role="status">
        {status === 'copied' ? m.work_names_copied({}, o) : status === 'failed' ? m.work_names_copy_failed({}, o) : ''}
      </span>
    </span>
  );
}

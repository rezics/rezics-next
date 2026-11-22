import type { ModrinthPackRelease, ModrinthProject } from '@rezics/launcher-contract';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useCallback, useId, useState } from 'react';
import { Failure, Pager, Pending, usePaging, useRemote } from '../renderer/actions';
import type { DesktopApi } from '../shared/desktop';

export type PackBrowserApi = Pick<DesktopApi, 'searchModrinthPacks' | 'listModrinthPackVersions'>;

export function ModrinthPackBrowser({
  api,
  disabled,
  select,
}: {
  api: PackBrowserApi;
  disabled: boolean;
  select: (release: ModrinthPackRelease) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<ModrinthProject>();
  const pages = usePaging();
  const load = useCallback(() => api.searchModrinthPacks(query, pages.cursor), [api, query, pages.cursor]);
  const results = useRemote(load);
  const next = results.data?.nextCursor;

  if (project)
    return (
      <PackVersions
        api={api}
        project={project}
        disabled={disabled}
        select={select}
        back={() => setProject(undefined)}
      />
    );

  return (
    <section className="grid gap-3" aria-label="Browse Modrinth packs">
      <form
        className="search stack items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text === query && !pages.cursor) results.reload();
          else {
            pages.reset();
            setQuery(text);
          }
        }}
      >
        <Field>
          <FieldLabel htmlFor={id}>Search Modrinth packs</FieldLabel>
          <Input
            id={id}
            value={draft}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={disabled || results.pending}>
          Search
        </Button>
      </form>
      {results.pending && <Pending>Loading Modrinth packs…</Pending>}
      <Failure error={results.error} retry={results.reload} />
      {!results.pending && results.data?.items.length === 0 && <p className="muted">No packs matched this search.</p>}
      {!results.pending && (
        <ul className="rows">
          {results.data?.items.map((result) => (
            <li key={result.id} className="row-item">
              <div className="row-content">
                <div className="row-text">
                  <strong>{result.title}</strong>
                  <span className="muted">{result.summary}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Versions for ${result.title}`}
                  onClick={() => setProject(result)}
                >
                  Versions
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!disabled && !results.pending && (pages.cursor || next) && (
        <Pager cursor={pages.cursor} previous={pages.previous} next={next ? () => pages.next(next) : undefined} />
      )}
    </section>
  );
}

function PackVersions({
  api,
  project,
  disabled,
  select,
  back,
}: {
  api: PackBrowserApi;
  project: ModrinthProject;
  disabled: boolean;
  select: (release: ModrinthPackRelease) => void;
  back: () => void;
}) {
  const pages = usePaging();
  const load = useCallback(
    () => api.listModrinthPackVersions(project.id, pages.cursor),
    [api, project.id, pages.cursor],
  );
  const results = useRemote(load);
  const next = results.data?.nextCursor;
  return (
    <section className="grid gap-3" aria-label="Modrinth pack versions">
      <div className="section-heading">
        <h3>{project.title}</h3>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={back}>
          Back to pack results
        </Button>
      </div>
      {results.pending && <Pending>Loading pack releases…</Pending>}
      <Failure error={results.error} retry={results.reload} />
      {!results.pending && results.data?.items.length === 0 && (
        <p className="muted">No compatible .mrpack releases were listed.</p>
      )}
      {!results.pending && (
        <ul className="rows">
          {results.data?.items.map((release) => (
            <li key={release.id} className="row-item">
              <div className="row-content">
                <div className="row-text">
                  <strong>{release.title}</strong>
                  <MetaLine
                    items={[release.version, release.channel, ...release.loaders, release.gameVersions.join(', ')]}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Preview ${release.title}`}
                  onClick={() => select(release)}
                >
                  Preview
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!disabled && !results.pending && (pages.cursor || next) && (
        <Pager cursor={pages.cursor} previous={pages.previous} next={next ? () => pages.next(next) : undefined} />
      )}
    </section>
  );
}

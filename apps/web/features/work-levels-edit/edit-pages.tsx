import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { RelationRows } from '../work-levels/connections.tsx';
import { EditionsPage } from '../work-levels/pages.tsx';
import { namesOf, readParts, readRealizations, readRelations } from '../work-levels/read.ts';
import { relationRows } from '../work-levels/relation-rows.ts';
import { nameOf } from '../work-levels/names.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { readWorkHeader, reader } from '../work-page/read.ts';
import { addRealization, addRelease, changeParts, recordRelation } from './actions.ts';
import { mayEdit, readAllowedActions } from './authority.ts';
import { EditFrame, NoAuthority } from './edit-frame.tsx';
import { RealizationEditor, ReleaseEditor, type CoverableRealization } from './editions-editor.tsx';
import { readKindOptions } from './read.ts';
import { copyOf } from './messages.ts';
import { PartsEditor, type EditablePart } from './parts-editor.tsx';
import { RelationEditor } from './relation-editor.tsx';
import { editHref, type EditSection } from './route.ts';

// Server compositions of the three edit pages. Each reads Main, asks Main whether the viewer may
// edit, and hands the editors exactly what Main said; no editor is rendered without the authority.

const PARTS_PAGE = 50;

async function frame(workRef: string, id: string, section: EditSection, locale: UiLocale) {
  const [allowed, header, { signedIn }] = await Promise.all([readAllowedActions(id), readWorkHeader(id, locale), reader()]);
  return { allowed, header: header.ok ? header.data : null, signedIn, t: copyOf(locale),
    title: header.ok ? header.data.title.value : '', workRef, section };
}

type Frame = Awaited<ReturnType<typeof frame>>;

function Shell({ frame: f, locale, children }: { frame: Frame; locale: UiLocale; children: React.ReactNode }) {
  return <EditFrame workRef={f.workRef} title={f.title} current={f.section} t={f.t}>
    {mayEdit(f.allowed) ? children : <NoAuthority workRef={f.workRef} signedIn={f.signedIn} t={f.t}
      signInHref={signInPath(localizedPath(editHref(f.workRef, f.section), locale))} />}
  </EditFrame>;
}

export async function PartsEditPage({ workRef, id, after, locale }: { workRef: string; id: string; after?: string; locale: UiLocale }) {
  const f = await frame(workRef, id, 'parts', locale);
  if (!mayEdit(f.allowed)) return <Shell frame={f} locale={locale}>{null}</Shell>;
  const parts = await readParts(id, { after, limit: PARTS_PAGE });
  const page = parts.ok ? parts.data : null;
  // A Work with no composition answers 404 and has no list yet: the first part starts one.
  const names = await namesOf(page?.parts.flatMap(part => part.work ?? []) ?? []);
  const rows: EditablePart[] = (page?.parts ?? []).map(part => ({ occurrence: part.occurrence, role: part.role,
    label: part.displayLabel ?? part.labels[0]?.value ?? '', inclusion: part.inclusion ?? 'required',
    name: part.work ? nameOf(names, part.work)?.value ?? null : null }));
  const base = editHref(workRef, 'parts');
  return <Shell frame={f} locale={locale}>
    <section className="grid gap-4" aria-labelledby="parts-heading">
      <h2 id="parts-heading" className="font-semibold text-xl">{f.t.partsHeading}</h2>
      <p className="text-muted-foreground text-sm">{f.t.partsHelp}</p>
      <PartsEditor work={id} structure={page?.structure ?? null} head={page?.revision ?? null} parts={rows}
        allowed={f.allowed} locale={locale} action={changeParts} t={f.t}
        links={{ first: after ? base : null, next: page?.next ? `${base}?after=${encodeURIComponent(page.next)}` : null }} />
    </section>
  </Shell>;
}

export async function RelationsEditPage({ workRef, id, locale }: { workRef: string; id: string; locale: UiLocale }) {
  const f = await frame(workRef, id, 'relations', locale);
  if (!mayEdit(f.allowed)) return <Shell frame={f} locale={locale}>{null}</Shell>;
  const [kinds, relations] = await Promise.all([readKindOptions(locale), readRelations(id, { limit: 20 })]);
  const rows = relations.ok ? relationRows(relations.data.items) : [];
  return <Shell frame={f} locale={locale}>
    <section className="grid gap-4" aria-labelledby="relations-heading">
      <h2 id="relations-heading" className="font-semibold text-xl">{f.t.relationsHeading}</h2>
      {f.header ? <RelationEditor work={id} mainVersion={f.header.mainVersion} head={f.header.mainVersionRevision}
        kinds={kinds.ok ? kinds.data : []} allowed={f.allowed} locale={locale} action={recordRelation} t={f.t} /> : null}
    </section>
    {rows.length ? <section className="grid gap-4" aria-labelledby="current-relations">
      <h2 id="current-relations" className="font-semibold text-xl">{f.t.currentRelations}</h2>
      <RelationRows rows={rows} locale={locale} t={levelsCopy(locale)} />
    </section> : null}
  </Shell>;
}

export async function EditionsEditPage({ workRef, id, locale, pageMessages }: {
  workRef: string; id: string; locale: UiLocale; pageMessages: WorkPageMessages;
}) {
  const f = await frame(workRef, id, 'editions', locale);
  if (!mayEdit(f.allowed)) return <Shell frame={f} locale={locale}>{null}</Shell>;
  const realizations = await readRealizations(id);
  const own: CoverableRealization[] = realizations.ok ? realizations.data.items.map(item => ({
    id: item.id, revision: item.revision, work: item.work, language: item.language })) : [];
  return <Shell frame={f} locale={locale}>
    <div className="grid gap-6">
      {f.header ? <RealizationEditor work={id} mainVersion={f.header.mainVersion} mainRevision={f.header.mainVersionRevision}
        existing={own} allowed={f.allowed} action={addRealization} t={f.t} /> : null}
      <ReleaseEditor work={id} own={own} allowed={f.allowed} locale={locale} action={addRelease} t={f.t} />
    </div>
    <section className="grid gap-4" aria-labelledby="current-editions">
      <h2 id="current-editions" className="font-semibold text-xl">{f.t.currentEditions}</h2>
      <EditionsPage workRef={workRef} id={id} query={{}} locale={locale} pageMessages={pageMessages} edit={false} />
    </section>
  </Shell>;
}

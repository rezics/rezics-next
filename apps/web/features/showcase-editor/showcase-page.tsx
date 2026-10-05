import type { ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { WorkShowcase } from '../api/showcase.ts';
import { signInPath } from '../auth/paths.ts';
import { coverKindOf } from '../catalogue/work.ts';
import { zoneImage, zoneText } from '../realm/adapt.ts';
import { readWorkHeader, reader } from '../work-page/read.ts';
import { globalWorkHref } from '../work-page/route.ts';
import type { WorkHeader } from '../work-page/types.ts';
import { mayEdit } from '../work-levels-edit/allowed.ts';
import { readAllowedActions } from '../work-levels-edit/authority.ts';
import { EditFrame, NoAuthority } from '../work-levels-edit/edit-frame.tsx';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import { editHref, workIri } from '../work-levels-edit/route.ts';
import { readPreviewTitle, saveShowcaseArt, saveShowcaseTrailer } from './actions.ts';
import { ShowcaseEditor } from './editor.tsx';
import { copyOf, messages } from './messages.ts';

// The server composition of `/w/{ref}/edit/showcase`. Like the other edit pages it shows editors
// only to a viewer Main lets edit the Work; Main still admits each save against the authority that
// selects the Work's cover, and the editor says so in words when it refuses.

/** The Work's art as the editor reads it: through the signed-in reader, in the Work's own (default) context. */
async function readArt(id: string): Promise<WorkShowcase | null> {
  const { main, actingSubject } = await reader();
  try {
    const { data, error } = await main.v1.resources.showcase.post({ profile: 'work-showcase-batch-v1', targets: [workIri(id)],
      ...(actingSubject ? { actingSubject } : {}) });
    const item = !error && data?.complete ? data.items[0] : null;
    return item?.status === 'available' ? item as WorkShowcase : null;
  } catch {
    return null;
  }
}

/** The Work as the stage's slide names it; "Why here?" points nowhere, as each Zone supplies its own reason. */
function workCard(header: WorkHeader, workRef: string, avatarQuery: string): ZoneWork {
  return { id: header.id, href: globalWorkHref(workRef), title: zoneText(header.title), cover: zoneImage(header.cover, avatarQuery),
    kind: coverKindOf(header.types), author: null, tagline: zoneText(header.tagline), status: header.completionStatus,
    chapters: header.chapterCount, words: header.wordCount, updatedAt: header.lastUpdatedAt, decision: '#why-here' };
}

export async function ShowcaseEditPage({ workRef, id, locale }: { workRef: string; id: string; locale: UiLocale }) {
  const [allowed, header, { signedIn, actingSubject }] = await Promise.all([readAllowedActions(id), readWorkHeader(id, locale), reader()]);
  const frameCopy = editCopy(locale);
  const t = copyOf(locale);
  const title = header.ok ? header.data.title.value : '';
  if (!mayEdit(allowed) || !actingSubject || !header.ok) {
    return <EditFrame workRef={workRef} title={title} current="showcase" t={frameCopy}>
      <NoAuthority workRef={workRef} signedIn={signedIn} t={frameCopy}
        signInHref={signInPath(localizedPath(editHref(workRef, 'showcase'), locale))} />
    </EditFrame>;
  }
  const art = await readArt(id);
  const avatarQuery = `?actingSubject=${encodeURIComponent(actingSubject)}`;
  return <EditFrame workRef={workRef} title={title} current="showcase" t={frameCopy}>
    <section className="grid gap-6" aria-labelledby="showcase-heading">
      <div className="grid gap-2">
        <h2 id="showcase-heading" className="font-semibold text-xl">{t.heading}</h2>
        <p className="max-w-3xl text-pretty text-muted-foreground text-sm">{t.intro}</p>
      </div>
      <ShowcaseEditor work={{ id, card: workCard(header.data, workRef, avatarQuery), title: zoneText(header.data.title),
        tagline: zoneText(header.data.tagline) }} art={art} actingSubject={actingSubject} locale={locale} messages={messages[locale]}
        saveArt={saveShowcaseArt} saveTrailer={saveShowcaseTrailer} loadTitle={readPreviewTitle} />
    </section>
  </EditFrame>;
}

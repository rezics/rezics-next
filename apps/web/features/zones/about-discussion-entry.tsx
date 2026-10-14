import type { UiLocale } from '../../i18n/define.ts';
import { readSession } from '../auth/session.ts';
import { resolveSite } from '../realm/read.ts';
import { reader } from '../work-page/read.ts';
import { readPlatformAccess } from '../api/main.ts';
import { gateFor } from '../api/platform-access.ts';
import { readEntityProjection } from '../entity-page/read.ts';
import { readAboutDiscussion } from './about-discussion-api.ts';
import { AboutDiscussion } from './about-discussion.tsx';

/** Shared by Work, entity and mounted document frames; Main chooses the current attachment. */
export async function ZoneAboutDiscussion({ zone, spaceRef, path, href, locale }: {
  zone?: string; spaceRef?: string; path: string; href: string; locale: UiLocale;
}) {
  let recoveryScope: {
    zone: string; path: string; actingSubject: string | null; signedIn: boolean; personal: boolean; postingOpen: boolean;
  } | undefined;
  try {
    if (!zone && spaceRef) {
      const site = await resolveSite(spaceRef, locale);
      if (site.kind === 'site') zone = site.zone;
    }
    if (!zone) return null;
    const [viewer, session, access] = await Promise.all([reader(), readSession(), readPlatformAccess()]);
    const personal = session?.agent.status === 'selected' && session.agent.agent.kind === 'person'
      && session.agent.agent.iri === viewer.actingSubject;
    const postingOpen = gateFor(access)('postV1RealmsByRealmAbout-posts');
    recoveryScope = {
      zone: `https://rezics.com/id/${zone.slice(-36)}`, path,
      actingSubject: viewer.actingSubject ?? null, signedIn: viewer.signedIn, personal, postingOpen,
    };
    const read = await readAboutDiscussion(viewer.main, {
      zone, path, signedIn: viewer.signedIn, actingSubject: viewer.actingSubject, personal,
      postingOpen,
    }, async resource => {
      // Share the entity frame's request cache. Posting always uses a current
      // projection, even when the frame renders a retained reading position.
      const projection = await readEntityProjection(resource.slice(-36), undefined);
      return projection.ok ? projection.data.target : null;
    });
    return <AboutDiscussion read={read} locale={locale} href={href} recoveryScope={recoveryScope} />;
  } catch {
    return <AboutDiscussion read={{ kind: 'unavailable' }} locale={locale} href={href}
      {...(recoveryScope ? { recoveryScope } : {})} />;
  }
}


import type { UiLocale } from '../../i18n/define.ts';
import { readSession } from '../auth/session.ts';
import { resolveSite } from '../realm/read.ts';
import { reader } from '../work-page/read.ts';
import { readPlatformAccess } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { readAboutDiscussion } from './about-discussion-api.ts';
import { AboutDiscussion } from './about-discussion.tsx';

/** Shared by the Work, entity and home renderers; only Main chooses the current attachment. */
export async function ZoneAboutDiscussion({ zone, ref, path, href, locale }: {
  zone?: string; ref?: string; path: string; href: string; locale: UiLocale;
}) {
  let recoveryScope: {
    zone: string; path: string; actingSubject: string | null; signedIn: boolean; personal: boolean;
  } | undefined;
  try {
    if (!zone && ref) {
      const site = await resolveSite(ref, locale);
      if (site.kind === 'site') zone = site.zone;
    }
    if (!zone) return null;
    const [viewer, session, access] = await Promise.all([reader(), readSession(), readPlatformAccess()]);
    const personal = session?.agent.status === 'selected' && session.agent.agent.kind === 'person'
      && session.agent.agent.iri === viewer.actingSubject;
    recoveryScope = {
      zone: `https://rezics.com/id/${zone.slice(-36)}`, path,
      actingSubject: viewer.actingSubject ?? null, signedIn: viewer.signedIn, personal,
    };
    const read = await readAboutDiscussion(viewer.main, {
      zone, path, signedIn: viewer.signedIn, actingSubject: viewer.actingSubject, personal,
      postingOpen: operationOpen('postV1RealmsByRealmAbout-posts', access),
    });
    return <AboutDiscussion read={read} locale={locale} href={href} recoveryScope={recoveryScope} />;
  } catch {
    return <AboutDiscussion read={{ kind: 'unavailable' }} locale={locale} href={href}
      {...(recoveryScope ? { recoveryScope } : {})} />;
  }
}


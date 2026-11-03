import { useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import type { SpacePageData } from './space';
import { useSpacePageLifetime } from './space-page-lifetime';
import { RealmCatalogueNavigation } from './realm-catalogue-navigation';

/**
 * The route host owns read/session admission. This smaller boundary owns only a local entry visit:
 * changing a read, route, locale or reader releases its draft and fences detached event handlers.
 * No catalogue or participation read is started here.
 */
export function RealmCatalogueCurrent({ page, available }: { page: SpacePageData; available: boolean }) {
  const lifetime = useSpacePageLifetime();
  const session = useSession();
  const location = useLocation();
  const locale = getLocale();
  const serial = useRef(0);
  const realm = page.realm;
  const admitted = Boolean(
    available &&
    realm &&
    realm.presentation?.state !== 'hidden' &&
    realm.continuity?.ownershipState !== 'orphaned' &&
    (realm.credentialMode !== 'session' || (session.state === 'signed-in' && session.subject)) &&
    (!lifetime || lifetime.admitted()),
  );
  const source = useMemo(
    () => ({ serial: ++serial.current, active: true, connected: false }),
    [
      page,
      realm,
      admitted,
      locale,
      location.pathname,
      location.searchStr,
      lifetime,
      session.state,
      session.subject,
      session.csrfToken,
    ],
  );
  const current = useRef(source);
  // Retire during replacement render, before effects and before the successor can expose controls.
  if (current.current !== source) current.current.active = false;
  current.current = source;
  useLayoutEffect(() => {
    source.connected = true;
    return () => {
      source.connected = false;
    };
  }, [source]);
  const isCurrent = () =>
    source.active && source.connected && current.current === source && admitted && (!lifetime || lifetime.current());
  const community = realm?.presentation?.state === 'available' ? realm.presentation.value : null;
  return (
    <RealmCatalogueNavigation
      key={source.serial}
      realm={admitted && realm ? { id: realm.id, name: community?.name ?? realm.title } : null}
      locale={locale}
      isCurrent={isCurrent}
    />
  );
}

import { installZoneAddresses } from '@rezics/zone-sdk';
import { isUiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';

/**
 * Official packages ask the SDK for a path. The web still owns how a Space
 * and a locale are written; install these rules before a package slot runs.
 */
const hostZoneAddresses = {
  site: (segment: string) => spaceHref(segment, 'site'),
  localized: (path: string, locale: string) => localizedPath(path, isUiLocale(locale) ? locale : 'en'),
};

export function installHostZoneAddresses(): void {
  installZoneAddresses(hostZoneAddresses);
}

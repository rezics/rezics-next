import type { UiLocale } from '../../i18n/define.ts';
import { withEnglish } from '../../i18n/define.ts';
import { messages as manage, type ManageMessages } from '../manage/messages.ts';
import { messages as shell, type ShellMessages } from '../shell/messages.ts';
import manage0 from '../manage/messages/de.ts';
import shell0 from '../shell/messages/de.ts';
import manage1 from '../manage/messages/es.ts';
import shell1 from '../shell/messages/es.ts';
import manage2 from '../manage/messages/fr.ts';
import shell2 from '../shell/messages/fr.ts';
import manage3 from '../manage/messages/ja.ts';
import shell3 from '../shell/messages/ja.ts';
import manage4 from '../manage/messages/ko.ts';
import shell4 from '../shell/messages/ko.ts';
import manage5 from '../manage/messages/zh-Hans.ts';
import shell5 from '../shell/messages/zh-Hans.ts';
import manage6 from '../manage/messages/zh-Hant.ts';
import shell6 from '../shell/messages/zh-Hant.ts';
const manageLocales: Record<UiLocale, Partial<ManageMessages>> = { en: manage, 'de': manage0, 'es': manage1, 'fr': manage2, 'ja': manage3, 'ko': manage4, 'zh-Hans': manage5, 'zh-Hant': manage6 };
const shellLocales: Record<UiLocale, Partial<ShellMessages>> = { en: shell, 'de': shell0, 'es': shell1, 'fr': shell2, 'ja': shell3, 'ko': shell4, 'zh-Hans': shell5, 'zh-Hant': shell6 };

/** The story boundary uses the same eight catalogs as the production management layout. */
export function zoneManagementMessages(locale: UiLocale) {
  return { manage: withEnglish(manage, manageLocales[locale]), shell: withEnglish(shell, shellLocales[locale]) };
}

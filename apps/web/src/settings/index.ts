/** Settings feature entry for route and shell composition. */
export { SettingsPageView, retrySettingsSession, SignedOutSettings, SettingsSessionRecovery } from './settings-page';
export { readSettingsPage } from './actions';
export { loadSettingsPage, type SettingsPage } from './preferences';
export {
  SettingsShellProvider,
  useSettingsShell,
  createSettingsShellPort,
  productionSettingsShellPort,
} from './adapters/shell';
export type { SettingsShellPort, SettingsSessionObservation } from './ports/shell';
export { authManagementPageHref, type AuthManagementPagePath } from './auth-management';
export { securityHrefFromIssuer, trustedAuthUrl, accountSafetyLinks, accountRenameHref } from './account-safety-links';

import { m } from './paraglide/messages.js';

/** Presentation only: exact native scopes, never registration or grant authority.
 * Protocol scopes: services/auth/src/website-provider.ts and website.ts.
 * Actions: semantic/http/subjects.ts and access/README.md in services/kernel/src.
 * Unknown tokens (including familiar prefixes) deliberately keep the fallback.
 */
export function permissionDescription(scope: string): { label: string; detail: string } {
  switch (scope) {
    case 'openid':
      return { label: m.auth_consent_scope_openid(), detail: m.auth_permission_description_openid_detail() };
    case 'offline_access':
      return {
        label: m.auth_consent_scope_offline_access(),
        detail: m.auth_permission_description_offline_access_detail(),
      };
    case 'subject:read':
      return {
        label: m.auth_permission_description_subject_read(),
        detail: m.auth_permission_description_subject_read_detail(),
      };
    case 'account:read':
      return {
        label: m.auth_permission_description_account_read(),
        detail: m.auth_permission_description_account_read_detail(),
      };
    case 'account:update':
      return {
        label: m.auth_permission_description_account_update(),
        detail: m.auth_permission_description_account_update_detail(),
      };
    case 'account:manage':
      return {
        label: m.auth_permission_description_account_manage(),
        detail: m.auth_permission_description_account_manage_detail(),
      };
    case 'account:delete':
      return {
        label: m.auth_permission_description_account_delete(),
        detail: m.auth_permission_description_account_delete_detail(),
      };
    case 'organization:create':
      return {
        label: m.auth_permission_description_organization_create(),
        detail: m.auth_permission_description_organization_create_detail(),
      };
    default:
      return {
        label: m.auth_permission_description_unknown(),
        detail: m.auth_permission_description_unknown_detail(),
      };
  }
}

/** Keep exact tokens in action names even when two capabilities have the same label. */
export function permissionRemovalLabel(scope: string): string {
  return m.auth_permission_description_remove_exact({ permission: permissionDescription(scope).label, scope });
}

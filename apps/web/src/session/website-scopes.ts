/** Selected private sales scope; it must come from the real mounted action catalogue. */
export const creatorSalesScope = 'commerce_sale:list';

export function websiteRegistrationScopes(mountedActions: Iterable<string>): string[] {
  // Called by trusted composition with actual action names; Auth checks mounted membership.
  return [
    'openid',
    'offline_access',
    ...[...new Set(mountedActions)].filter((name) => name !== 'openid' && name !== 'offline_access').sort(),
  ];
}

/** Request only the configured registration. Existing sessions/refresh never acquire new consent here. */
export function websiteRequestedScopes(configured: string): string {
  return [...new Set(['openid', 'offline_access', ...configured.split(/\s+/).filter(Boolean)])].join(' ');
}

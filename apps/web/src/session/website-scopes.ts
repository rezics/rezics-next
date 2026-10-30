/** Selected private sales scope; it must come from the real mounted action catalogue. */
export const creatorSalesScope = 'commerce_sale:list';

export function websiteRegistrationScopes(mountedActions: Iterable<string>): string[] {
  // Auth rejects unmounted scopes. Once delivered, commerce_sale:list enters this exact registration/request set.
  return [...new Set(['openid', 'offline_access', ...mountedActions])];
}

/** Request only the configured registration. Existing sessions/refresh never acquire new consent here. */
export function websiteRequestedScopes(configured: string): string {
  return [...new Set(['openid', 'offline_access', ...configured.split(/\s+/).filter(Boolean)])].join(' ');
}

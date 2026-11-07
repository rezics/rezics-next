/** Protocol scopes plus mounted Kernel actions, without loading Auth's workflow host. */
export function websiteDeploymentScopes(actions: Iterable<string>): string[] {
  return [
    'openid',
    'offline_access',
    ...[...new Set([...actions, 'organization:create', 'account:manage', 'account:delete'])]
      .filter((name) => name !== 'openid' && name !== 'offline_access')
      .sort(),
  ];
}

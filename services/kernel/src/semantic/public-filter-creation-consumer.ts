/** The ordinary outbox checkpoint pins the original creation/change window.
 * It is retained until native Source/copy retirement, never advanced by a query.
 */
export function publicFilterCreationConsumer(bootstrap: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootstrap))
    throw new TypeError('Creation retention requires a native bootstrap');
  return 'public_filter_' + bootstrap.replaceAll('-', '');
}

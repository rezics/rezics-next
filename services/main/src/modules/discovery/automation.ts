/** Server-only capability. JSON request bodies cannot carry this symbol. The
 * inactive ledger principal has no login, representation or management grant. */
export const discoveryAutomation = Symbol('discovery-refresh');
export const DISCOVERY_SERVICE_PRINCIPAL = '00000000-0000-4000-8000-000000000380';
export interface DiscoveryAutomation { [discoveryAutomation]: string | null }
export const automaticDiscovery = (owner: string | null): DiscoveryAutomation => ({ [discoveryAutomation]: owner });

import type { Pool, PoolClient } from 'pg';
import { securityResponseLimits } from '@rezics/auth-contract';
import { securityId, securityDisplay, securityScopes } from './security-response-bounds.ts';
import {
  SecurityInventoryDenied,
  securityCursors,
  securityPageInput,
  type SecurityCursorBinding,
  type SecurityPageInput,
  type SecurityView,
} from './security-cursor.ts';

export type OwnedSecurityClient = {
  client_id: string;
  display_name: string | null;
  disabled: boolean;
  scopes: string[];
};
export type SecurityConsent = {
  client_id: string;
  display_name: string | null;
  granted: string[];
  status: 'current' | 'inactive' | 'unavailable';
  reducible: boolean;
  pending_reduction: boolean;
};
export type OwnedSecurityClientsPage = { clients: OwnedSecurityClient[]; next: string | null };
export type SecurityConsentsPage = { consents: SecurityConsent[]; next: string | null };
export type SecurityInventoryInput = SecurityPageInput & { headers: Headers };
export interface SecurityInventory {
  listClients(input: SecurityInventoryInput): Promise<OwnedSecurityClientsPage>;
  listConsents(input: SecurityInventoryInput): Promise<SecurityConsentsPage>;
}

type ClientRow = {
  client_id: string;
  display_name: string | null;
  disabled: boolean | null;
  first_party: boolean;
  scopes: unknown;
  erasure_fenced: boolean;
  ready: boolean;
  reducing: boolean;
};
type ConsentRow = { client_id: string; scopes: unknown; pending_scopes: unknown };
function current(client: ClientRow | undefined, scopeLimit: number): client is ClientRow & { scopes: string[] } {
  return (
    !!client &&
    client.disabled === false &&
    !client.erasure_fenced &&
    client.ready &&
    !client.reducing &&
    securityScopes(client.scopes, scopeLimit)
  );
}
function display(client: ClientRow | undefined): string | null {
  // Only the native configured service label, never provider name/free metadata.
  return client && !client.erasure_fenced
    ? securityDisplay(client.display_name, securityResponseLimits.displayName)
    : null;
}

/** Private native reader. Account/session bindings are supplied only by the
 * service's current human proof, never by a public request parameter. */
export function securityInventory(
  database: Pool,
  secret: string,
  issuer: string,
  now: () => number,
  scopeLimit = 1000,
) {
  const cursors = securityCursors(secret, issuer, now);
  async function page<T>(
    view: SecurityView,
    binding: SecurityCursorBinding,
    input: SecurityPageInput,
    read: (connection: PoolClient, after: string | null, limit: number) => Promise<{ rows: T[]; last: string | null }>,
  ): Promise<{ rows: T[]; next: string | null }> {
    const { cursor, limit } = securityPageInput(input);
    const after = cursors.read(cursor, view, binding, limit);
    const connection = await database.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // humanProof already validates session/consent/epoch. Also refuse disabled
      // or fenced native issuer bindings, including the legacy cookie path.
      const admitted = await connection.query(
        `SELECT client_id FROM auth_client WHERE client_id=$1 AND disabled=false AND NOT erasure_fenced`,
        [binding.clientId],
      );
      if (!admitted.rowCount) throw new SecurityInventoryDenied(401);
      const result = await read(connection, after, limit);
      const next = result.last === null ? null : cursors.write(result.last, view, binding, limit);
      await connection.query('COMMIT');
      return { rows: result.rows, next };
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  return {
    async clients(binding: SecurityCursorBinding, input: SecurityPageInput): Promise<OwnedSecurityClientsPage> {
      const result = await page('clients', binding, input, async (connection, after, limit) => {
        // Existing erasure_auth_client_0(userId,client_id) is the native owner
        // keyset. Consent's primary key supplies the other view; no new index.
        const { rows } = await connection.query<ClientRow>(
          `SELECT c.client_id,CASE WHEN c.display_name_writer=1 THEN c.display_name END AS display_name,c.disabled,c.scopes,c.erasure_fenced
           FROM auth_client c WHERE c."userId"=$1 AND c.client_id>$2 ORDER BY c.client_id LIMIT $3`,
          [binding.accountId, after ?? '', limit + 1],
        );
        const selected = rows.slice(0, limit);
        return {
          rows: selected.map((client) => {
            if (!client.erasure_fenced && !securityScopes(client.scopes, scopeLimit))
              throw new SecurityInventoryDenied(503);
            return {
              client_id: securityId(client.client_id),
              display_name: display(client),
              disabled: client.disabled !== false || client.erasure_fenced,
              scopes:
                !client.erasure_fenced && securityScopes(client.scopes, scopeLimit)
                  ? [...new Set(client.scopes)].sort()
                  : [],
            };
          }),
          last: rows.length > limit ? selected.at(-1)!.client_id : null,
        };
      });
      return { clients: result.rows, next: result.next };
    },
    async consents(binding: SecurityCursorBinding, input: SecurityPageInput): Promise<SecurityConsentsPage> {
      const result = await page('consents', binding, input, async (connection, after, limit) => {
        const { rows } = await connection.query<ConsentRow>(
          `SELECT client_id,scopes,pending_scopes FROM auth_consent
           WHERE account_id=$1 AND client_id>$2 ORDER BY client_id LIMIT $3`,
          [binding.accountId, after ?? '', limit + 1],
        );
        const selected = rows.slice(0, limit);
        // Exact bounded keys only, in the same snapshot as the native page.
        const metadata =
          selected.length === 0
            ? []
            : (
                await connection.query<ClientRow>(
                  `SELECT c.client_id,CASE WHEN c.display_name_writer=1 THEN c.display_name END AS display_name,c.disabled,c.first_party,c.scopes,c.erasure_fenced,
             EXISTS (SELECT 1 FROM auth_client_coverage v WHERE v.client_id=c.client_id AND v.ready) AS ready,
             EXISTS (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=c.client_id) AS reducing
           FROM auth_client c WHERE c.client_id=ANY($1::text[])`,
                  [selected.map((consent) => consent.client_id)],
                )
              ).rows;
        const clients = new Map(metadata.map((client) => [client.client_id, client]));
        return {
          rows: selected.map((consent): SecurityConsent => {
            const client = clients.get(consent.client_id);
            const available =
              current(client, scopeLimit) &&
              securityScopes(consent.scopes, scopeLimit) &&
              (consent.pending_scopes === null || securityScopes(consent.pending_scopes, scopeLimit));
            const granted = available
              ? [
                  ...new Set(
                    (consent.scopes as string[]).filter(
                      (scope) =>
                        client.scopes.includes(scope) &&
                        (consent.pending_scopes === null || (consent.pending_scopes as string[]).includes(scope)),
                    ),
                  ),
                ].sort()
              : [];
            return {
              client_id: securityId(consent.client_id),
              display_name: display(client),
              granted,
              status: !available ? 'unavailable' : granted.length ? 'current' : 'inactive',
              reducible: available && !client.first_party,
              pending_reduction: consent.pending_scopes !== null || client?.reducing === true,
            };
          }),
          last: rows.length > limit ? selected.at(-1)!.client_id : null,
        };
      });
      return { consents: result.rows, next: result.next };
    },
  };
}

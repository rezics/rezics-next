import { forwardToMain } from '../../../../../features/api/bff.ts';
import { serviceOrigin } from '../../../../../features/api/origins.ts';
import { webConfig } from '../../../../../features/config/env.ts';
import { CASE_CREDENTIAL_HEADER, relays, withCredential } from '../../../../../features/safety/relay.ts';

// A case's credential is a header, never a path or query, so no server log,
// proxy or referrer can hold it. The BFF's header list is fixed and does not
// carry it; this relay is the one place that sets it, for the two case routes.
// The call is anonymous: Main reads status and correspondence by credential
// alone, so a suspended or signed-out reporter is served the same way.
async function relay(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!relays(path, request.method)) return Response.json({ error: 'unknown API path' }, { status: 404 });
  return forwardToMain(request, path, { mainOrigin: serviceOrigin('MAIN_ORIGIN'), accessToken: undefined,
    clientIpHeader: webConfig().WEB_CLIENT_IP_HEADER,
    fetch: withCredential(request.headers.get(CASE_CREDENTIAL_HEADER) ?? '', fetch) });
}

export const GET = relay;
export const POST = relay;

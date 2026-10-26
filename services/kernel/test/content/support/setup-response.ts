export async function assertSetupResponse(
  response: Response,
  request: Request,
  expectedStatus?: number,
): Promise<Response> {
  const accepted = expectedStatus === undefined ? response.ok : response.status === expectedStatus;
  if (accepted) return response;

  const body = await response.text();
  throw new Error(`Setup ${request.method} ${request.url} failed (${response.status}): ${body}`);
}

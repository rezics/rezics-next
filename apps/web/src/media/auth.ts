export function viewerCredential(request: Request): string | null {
  // Development stand-in for the website's server-side session; no cookie is read yet.
  // The session change must add cross-site request protection for these routes.
  return request.headers.get('authorization');
}

// Request identity keeps simultaneous SSR renders isolated without trusting a client header.
const nonces = new WeakMap<Request, string>();

export function createNonce(request: Request): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...bytes));
  nonces.set(request, nonce);
  return nonce;
}

export function requestNonce(request: Request): string | undefined {
  return nonces.get(request);
}

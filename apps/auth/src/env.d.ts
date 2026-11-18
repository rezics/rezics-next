declare const __AUTH_ORIGIN__: string;
declare const __AUTH_TEST_PAGE_ORIGIN__: string;

declare namespace Cloudflare {
  interface Env {
    AUTH_SECURITY_SCOPE_CONFIGURATION?: string;
  }
}

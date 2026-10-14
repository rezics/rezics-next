// Stories import production readers that call `next/headers`. Vinext supplies it
// in the app. A replay host never reads a cookie or an incoming header; this
// stand-in only lets the module load. A call still returns an empty jar.

const empty = { get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} };

export async function cookies() {
  return empty;
}

export async function headers() {
  return new Headers();
}

export async function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}

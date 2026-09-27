export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;

export function normalizedHandle(value: string): string | null {
  const handle = value.trim().toLowerCase();
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

export function currentVanityHandle(handle: string | null): string | null {
  return handle && !/^agent-[0-9a-f-]{36}$/.test(handle) ? handle : null;
}

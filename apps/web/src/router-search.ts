export function parseSearch(searchString: string): Record<string, unknown> {
  const search = new URLSearchParams(searchString);
  const parsed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of search) {
    if (!Object.hasOwn(parsed, key)) parsed[key] = value;
    else if (Array.isArray(parsed[key])) (parsed[key] as string[]).push(value);
    else parsed[key] = [parsed[key] as string, value];
  }
  return parsed;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') params.append(key, item);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

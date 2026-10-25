const VERB = /^[a-z][A-Za-z0-9]*$/;
const INTERNAL_SUFFIX = /\/\$([a-z][A-Za-z0-9]*)$/;

/** Registers an AIP-136 custom method using a path Elysia can route. */
export function customMethod<const Path extends string, const Verb extends string>(
  path: Path,
  verb: Verb,
): `${Path}/$${Verb}` {
  if (path.endsWith('/') || VERB.exec(verb)?.[0] !== verb) throw new TypeError('Invalid custom method path or verb');
  return `${path}/$${verb}`;
}

export function customMethodVerb(path: string): string | undefined {
  return INTERNAL_SUFFIX.exec(path)?.[1];
}

/** Converts an internal route or OpenAPI path to its public AIP-136 form. */
export function customMethodPath(path: string): string {
  return path.replace(INTERNAL_SUFFIX, ':$1');
}

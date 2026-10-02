import { notFound } from 'next/navigation';
import { parseAddressSegment } from './path.ts';

/** Identity pages share the profile renderer without exposing a fabricated handle in their URL. */
export async function profileIdentityParams<T extends { ref: string }>(params: Promise<T>) {
  const { ref, ...rest } = await params;
  const parsed = parseAddressSegment(ref);
  if (!parsed || parsed.kind === 'name') notFound();
  return { ...rest, handle: `@agent-${parsed.id}` };
}

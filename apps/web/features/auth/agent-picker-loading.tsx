import { SkeletonText } from '@rezics/ui/skeleton';

/** Loading discovery is distinct from a completed empty or failed discovery. */
export function AgentPickerLoading({ heading, label }: { heading: string; label: string }) {
  return <section className="grid gap-5">
    <h1 className="font-semibold text-2xl">{heading}</h1>
    <div role="status" aria-label={label} aria-busy="true"><SkeletonText lines={4} /></div>
  </section>;
}

export function PendingPage() {
  return (
    <main aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="h-9 w-64 max-w-full animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div className="mt-4 h-5 w-96 max-w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-900" />
    </main>
  );
}

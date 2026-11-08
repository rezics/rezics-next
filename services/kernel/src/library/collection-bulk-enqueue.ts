/** DBOS steps serialize return values; enqueue handles own runtime state and are not workflow results. */
export async function enqueueAndDiscardHandle(enqueue: () => Promise<unknown>): Promise<void> {
  await enqueue();
}

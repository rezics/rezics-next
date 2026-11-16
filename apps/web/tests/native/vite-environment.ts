/** The two native Vite servers coexist with workerd, Kernel and Chromium in one command cgroup. */
export function nativeViteEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    // Rolldown and Rayon size separate native thread pools from the host CPU count.
    ROLLDOWN_WORKER_THREADS: env.ROLLDOWN_WORKER_THREADS ?? env.TOKIO_WORKER_THREADS ?? '4',
    RAYON_NUM_THREADS: env.RAYON_NUM_THREADS ?? '4',
  };
}

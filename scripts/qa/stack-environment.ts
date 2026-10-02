/** QA can hold up to eight JVMs beside the shared dev stack. Keep heap/direct
 * allocations below the container limit, including tmpfs and native overhead.
 * Persistent recovery children inherit these defaults as well as tmpfs shards.
 * https://docs.docker.com/reference/compose-file/services/#mem_limit */
export function qaStackEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    REZICS_FUSEKI_MEMORY_LIMIT: env.REZICS_QA_FUSEKI_MEMORY_LIMIT ?? '2g',
    REZICS_FUSEKI_JVM_ARGS:
      env.REZICS_QA_FUSEKI_JVM_ARGS ?? '-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m',
  };
}

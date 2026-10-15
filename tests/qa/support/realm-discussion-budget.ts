/** One-time producer work. Restore/readiness and physical custody keep their
 * separate 600-second bounds; consumers restore the retained result. */
export const realmSourceBuildDeadlineMs = 3_600_000;

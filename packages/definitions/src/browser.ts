// The portable entry includes release identity and released relation meaning.
// Catalogue artifact construction, exhaustive verification, lookup admission and files stay on the server entry.
export * from './portable.ts';

// Publication admission/validation and catalogue compilation are server operations.
// Keep them on the default entry: browsers submit publication through the
// Definitions API, whose native validator owns pattern analysis and its budget.
// No native checker or publication-construction module belongs in this graph.

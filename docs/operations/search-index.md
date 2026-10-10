# Search index qualification

Public text stays closed until this process has installed a search-journal
baseline for the current text generation. `GET /rezics/command?deltaSince=-1`
then answers `available:true`. `available:false` means no baseline is installed.
Graph reads can still succeed.

Fuseki records the decision on the command module's logger. A refusal is one
WARN line. A subject, when the check names one, is the IRI in brackets. Stored
fields and document bodies are never written there.

```text
startup-audit failed: <reason> [<subject>]
journal invalidated: <reason> [<caller>]
```

The startup audit reasons are fixed: control position missing, control has no
text generation, lucene index unavailable, control position held, public anchor
absent, a Realm-owner refusal, a public body or rank field that differs from
RDF, a public MatchUnit absent from the index, and an index population that
differs from the public MatchUnit count. I/O and text-index failures use the
exception's short message, or the exception class when that message is long.
A Content receipt written before the native source pin has no
`searchDeltaContentSource`. Startup still qualifies that unit when its stored
body equals the RDF body. A pin that differs from the current authority, or a
stored body that differs from RDF, stays closed.
`journal invalidated` names the caller that dropped the in-memory baseline
(`qualify`, `fenceBeforeWrite`, `qualifiedProof`, or the writer that withdrew
it after a commit).

A baseline that passes the audit is one INFO line, with the control epoch, the
text generation IRI, the public population, and the Lucene commit generation:

```text
search journal baseline installed: epoch=<epoch> generation=<generation> population=<count> luceneGeneration=<generation>
```

Requalification retries a failed audit with back-off and logs each attempt the
same way. An uncertain or rebuilding index stays unavailable even when graph
reads work; the offline rebuild procedure is in
[recovery](recovery.md#offline-lucene-rebuild).

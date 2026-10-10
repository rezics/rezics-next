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
`searchDeltaContentSource`. Startup still qualifies that unit when its Lucene
document is the plain body row (no rank context and no external text key) and
the stored body equals the RDF body. A rank-decorated document, a pin that
differs from the current authority, or a stored body that differs from RDF
stays closed.
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

## Rebuild states

`task search:rebuild` stores one job and moves it to `activated`. The public
anchor is absent from quarantine until activation, and activation writes the
new text generation and the anchor in the same command. A rerun starts from
whatever receipts are already stored:

| State | What is stored | What a rerun does |
| --- | --- | --- |
| not started | No quarantine receipt, anchor present | Quarantines and stores the Content owner cut |
| quarantined | Anchor absent, quarantine receipt stored | Clears Content units |
| cleared | Terminal clear receipt | Indexes when no offline record covers this generation and sequence. Units that returned while the anchor is absent are cleared again |
| offline-indexed | Cleared-family receipt with the indexer digest for this generation and sequence | Replays from the stored cut |
| replayed | Rebuild cursor at the stored cut | Activates |
| activated | Activate receipt, control generation, and anchor agree | Promotes the SQL checkpoint |

A `urn:rezics:content:match-unit:` subject that is not a MatchUnit with a
Content projection still refuses with `Content units remain after terminal
clear; offline rebuild refused`. That subject cannot be cleared. A live index,
anchor present, is not rebuilt in place.

Stdout names each step this process finished:

```text
content-rebuild step: quarantined
content-rebuild step: cleared
content-rebuild step: offline-indexed
content-rebuild step: replayed
content-rebuild step: activated
```

`quarantined` is printed again on a resume because the receipt is still the
start of the job. `cleared` is printed when this process deleted Content units,
including units that came back after an earlier clear. `offline-indexed` means
the indexer ran in this process. A resume that already recorded that pass does
not print it. The last line is the JSON result. `elapsedMs` is the measured
time of this run.

A read or command that exceeds its budget exits with one line. The name is the
read, and a paged read includes the page:

```text
progress: offline receipt: timed out after 4282ms (budget 8000ms)
clear: page 3: timed out after 8100ms (budget 8000ms)
offline: command: timed out after 10012ms (budget 10000ms)
```

Resume reads are `progress: anchor`, `progress: quarantine receipt`,
`progress: cleared receipt`, `progress: content units`,
`progress: malformed content`, `progress: index control`,
`progress: offline receipt`, `progress: activation receipt`, and
`adopt: quarantine job`. Each receipt read uses the receipt IRI for this job.
The offline receipt is that IRI for the job, the text generation, and the
control sequence the indexer command advanced from. The job file records that
sequence as `offlinePreSequence`. A resume uses it, and does not sort the
receipts graph.

## Resuming the stuck development stack

Stop the development server so Main is not writing, then rebuild, then start
it again:

```sh
# stop the task dev process
task search:rebuild
# start task dev again
```

The shared stack's job file `.temp/stack/rezics-dev/content-rebuild.json`
already holds the job id. The command resumes that id. Do not pass a new one.
When that file is gone, one unread quarantine receipt supplies its job id.
When that receipt has none, pass the id with
`task search:rebuild -- --job <uuid>`.

A resume prints the step lines above and then one JSON object whose
`generation` is the activated text generation. The indexer command itself is
limited to 300 seconds. The interrupted attempt on this stack stopped at 214
seconds, before replay. Allow about 10 minutes for the full public graph and
read `elapsedMs` for the run that actually finished. Search stays closed until
the `activated` line; `GET /rezics/command?deltaSince=-1` then answers
`available:true`.

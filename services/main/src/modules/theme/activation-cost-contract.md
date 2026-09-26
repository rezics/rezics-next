# Theme activation cost contract

POST /v1/themes/{theme}/activations performs one Account token verification,
one Access registration and claim, at most two bounded Fuseki commands (the
activation and one terminal outcome), and at most eight total Fuseki queries,
health checks and commands on a fresh success or stale path. It reads the graph
receipt before dispatch and after a terminal command. A replay performs at most
two Fuseki calls (the lineage check and receipt read) and one idempotent Content
projection transaction.

The Content transaction locks one theme key, reads at most one head and one
receipt row, inserts one immutable activation row, and advances one head row.
History length and unrelated themes do not increase its row work. The graph
update touches the one theme head, one revision, one receipt, one outbox event
and the global sequence. Reads return one row and one graph row; neither scans
history or follows predecessors.

The integration test caps fresh and recovered writes at eight Fuseki calls and
ten counted Content statements, replay at two Fuseki calls and six Content
statements, a read at one Fuseki query, denied writes at two Fuseki calls, stale
writes at eight calls, idempotency conflicts at two calls, and a concurrent pair
at sixteen calls. The counters
bound application calls and rows in these paths; physical PostgreSQL and Jena
operator work remains subject to the shared complexity qualification.

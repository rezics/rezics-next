# Historical Access backend comparison lab

The retained 2026-09-22 run compares PostgreSQL, Fluree, SpiceDB/PostgreSQL and
OpenFGA/PostgreSQL. Fluree is retired from the current REZICS architecture. No
script or evidence here measures Fuseki, TDB2 or jena-text/Lucene; none qualifies
the current Access-to-Jena bridge. Preserve engine labels and raw numbers rather
than relabeling old results. Rerunning these archived commands is separate research
work, not a Jena launch gate or part of a documentation-only reconciliation.

This is a synthetic research harness, not the production Access implementation.
It compares a common five-predicate decision frame: representation, an explicit
exception, principal-based Realm exclusion, actor-based Realm exclusion and a
direct/dependent grant. A shared application combiner implements ordered rules.
It does not qualify login, principal admission, mutation authorization, complete
scope/expiry/ceiling semantics, field-level disclosure, strict revocation/drain,
real deployment throughput or durability.

The authority graphs contain one parent per dependent grant. Do not generalize
the query templates to arbitrary multi-parent dependency semantics without defining
and qualifying that contract. Domain workflow/audit records are not represented
in the specialized engines' comparison model.

## Requirements and isolation

- Linux, PostgreSQL 18 server/client tools on PATH.
- Verified release binaries: Fluree 4.2.1, SpiceDB 1.56.2, OpenFGA 1.21.0.
- A Python virtual environment with `requirements.txt` installed. The recorded
  run used Python 3.14.7; other compatible Python versions have not been qualified.
- A new task-owned `REZICS_ACCESS_LAB` directory. Existing PostgreSQL data directories
  are refused. Do not point this harness at an existing database or application.

The lab initializes its own synthetic PostgreSQL cluster and three databases,
binds loopback listeners to temporary ports, disables SpiceDB telemetry and uses
an explicitly synthetic test key. It also initializes its own Fluree directory.
No real credentials or user records are needed. The foreground lab process stops
its own servers when interrupted; keep its terminal open during the probe.

Example setup, with paths to locally obtained and checksum-verified binaries:

```sh
export REZICS_ACCESS_LAB="$(mktemp -d /tmp/rezics-access-lab-XXXXXX)"
export REZICS_FLUREE_BIN=/absolute/path/to/fluree
export REZICS_SPICEDB_BIN=/absolute/path/to/spicedb
export REZICS_OPENFGA_BIN=/absolute/path/to/openfga
python lab.py
```

In a second terminal using the same virtual environment and `REZICS_ACCESS_LAB`,
run these from this directory, once against that fresh lab:

```sh
python compare.py
python expanded.py
python fluree_policy.py
python fluree_optimize.py
python coherence.py
python final_measure.py
```

Then interrupt `lab.py`. Results/logs remain in `$REZICS_ACCESS_LAB/lab`.
`compare.py` creates a new OpenFGA store and resets only the synthetic native
PostgreSQL edge table; restarting the entire sequence should use a fresh lab.

## What the results mean

- `compare.py`: 12 stationary semantic scenarios per backend. The ordered policy
  combiner is application code; passing does not imply an engine natively supports
  arbitrary first-applicable policies.
- `expanded.py`: adds 12,000 unrelated edges, probes representation depths 1–16
  and 50 grant checks. These are synthetic shapes, not production scale.
- `coherence.py`: atomically switches between two states that both deny access.
  It looks for an invalid allow when separately obtained predicate answers are
  combined. This is a composition counterexample, not a claim that every use of
  an engine is unsafe. A zero count is not a general consistency proof.
- `fluree_policy.py`: verifies native policy order behavior and historical policy
  data after revocation, then demonstrates a current explicit deny guarding old
  content. Historical snapshots are not automatically current authority.
- `fluree_optimize.py`: compares query variants; nested negation can be much more
  expensive than separating direct assignment from dependent ancestry.
- `final_measure.py`: three rounds of 100 local decision-frame reads and 15 batches
  of 50 grant checks, using reused clients. These are different native transport
  and query paths. They omit actual Main/Rust, workload concurrency, authentication,
  mutation admission and production storage, so they do not rank general engine
  throughput. `/tmp` was tmpfs in the recorded run.

The scripts now use the optimized Fluree query. The retained
`expanded-original-query.json` and explain plan record the earlier slower query
shape; they are not its current performance. The recorded final measurement used
that optimized shape. All evidence files identify their limited experiment rather
than a product acceptance pass.

See [the owning research](../../../docs/research/access-storage-and-policy.md) and
[the implementation proposal](../../../docs/implementation/access-control.md).

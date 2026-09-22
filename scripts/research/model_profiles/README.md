# Historical model profile research probe

This archived harness produced 2026-09-22 reference-validator and Fluree 4.2.1
evidence. Fluree is retired from REZICS; this script does not exercise Jena, Fuseki,
TDB2 or jena-shacl, and is not a Jena quickstart or acceptance step. Its code and
`evidence.json` retain their original provenance. Rerunning it is separate research
work, outside the documentation-only architecture reconciliation.

This is a bounded research fixture for the [profile design](../../../docs/contracts/model-profiles.md),
not an application implementation or a complete conformance suite. It checks
standard-type extensions, label cardinality, repeated list entries, nullable vote
dimensions, open/closed shapes and the difference between shape validation and
identity/state-transition enforcement. Optional Fluree cases compare file
validation with stored-shape transactions, reference edits, configuration and CAS.

Use a task-owned virtual environment; keep output outside the repository:

```sh
python3 -m venv /tmp/rezics-profile-venv
/tmp/rezics-profile-venv/bin/python -m pip install -r scripts/research/model_profiles/requirements.txt
/tmp/rezics-profile-venv/bin/python scripts/research/model_profiles/probe.py --fluree /absolute/path/to/fluree
```

`--fluree` requires the official 4.2.1 CLI binary. Omitting it runs only reference
checks. Each run creates a fresh temporary directory with Turtle inputs, reports,
server log and `result.json`, including library versions and binary/shape digests.
Any loopback server started by the probe is stopped in `finally`. No production
ledger, saved Fluree configuration or project dependency is modified.

Some successful checks deliberately demonstrate a missing guarantee: both anchor
states conform, OWL infers equal identity, and removing a class target leaves no
validation focus. Their interpretation is recorded in the
[historical engine evidence](../../../docs/research/model-profile-engine-evidence.md).

#!/usr/bin/env python3
"""Exercise the fixed Work metadata profile with the pinned Jena SHACL helper."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model" / "tools" / "validate_work_metadata.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
WORK = "https://example.org/rezics-test/work"
MAIN = "https://example.org/rezics-test/main"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    outcomes = {}
    cases = [
        ("valid", True, None),
        ("missing-type", False, "rdf:type"),
        ("missing-main", False, "rv:mainVersion"),
    ]
    for name, expected, path in cases:
        command = [
            sys.executable, str(HELPER), "--data", str(FIXTURES / f"work-metadata-{name}.ttl"),
            "--work", WORK, "--main", MAIN,
            "--jena-home", str(args.jena_home), "--java-home", str(args.java_home),
        ]
        completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        assert completed.returncode == (0 if expected else 1), (name, completed.stdout, completed.stderr)
        result = json.loads(completed.stdout)
        assert result["conforms"] is expected, (name, result)
        if path is not None:
            assert "sh:resultPath" in result["report"] and path in result["report"], (name, result)
        outcomes[name] = {"conforms": result["conforms"], "exit_code": completed.returncode}
    print(json.dumps({
        "cases": ["MODEL15-fixed-work-profile", "MODEL17-explicit-focus-subset"],
        "profile_sha256": result["profile_sha256"],
        "jena_shacl": result["jena_shacl"],
        "java": result["java"],
        "outcomes": outcomes,
        "result": "pass",
    }, indent=2))


if __name__ == "__main__":
    main()

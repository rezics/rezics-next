#!/usr/bin/env python3
"""Validate one curated MainVersion classification Application and Decision."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "classification-direct-decision-v1.ttl"
PROFILE_SHA256 = "c33d12713979c86a3d29aa2fc6ebd4952f37bdece02a5aa6ba485fc48bda468b"
BASE = "https://rezics.com/definition/classification-direct-decision-v1"
RV = "https://rezics.com/vocab/"
SH = "http://www.w3.org/ns/shacl#"
GLOBAL = "urn:rezics:classification-context:global"
ISOLATE = "https://rezics.com/definition/classification-isolate-v1"
INHERIT = "https://rezics.com/definition/classification-inherit-global-v1"
NATIVE = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")
SLOT = re.compile(r"^urn:rezics:classification-slot:[0-9a-f]{64}$")


def property_rule(shape, predicate, *, value=None, absent=False):
    assert (value is not None) != absent
    constraint = f"<{SH}maxCount> 0" if absent else (
        f"<{SH}hasValue> <{value}> ; <{SH}minCount> 1 ; <{SH}maxCount> 1")
    return f"\n<{shape}> <{SH}property> [ <{SH}path> <{RV}{predicate}> ; {constraint} ] ."


def validate(data, args):
    refs = ("work", "main", "sense", "sense_revision", "application", "decision",
            "proposer", "decider")
    if any(not NATIVE.fullmatch(getattr(args, key)) for key in refs):
        raise ValueError("invalid native classification reference")
    if not SLOT.fullmatch(args.slot):
        raise ValueError("invalid classification slot")
    if args.outcome not in ("accepted", "rejected"):
        raise ValueError("invalid classification outcome")
    if args.context_kind == "global":
        if args.context != GLOBAL or args.realm or args.context_revision:
            raise ValueError("Global context references differ")
    elif args.context_kind == "realm":
        if not NATIVE.fullmatch(args.context) or not args.realm or not NATIVE.fullmatch(args.realm) \
                or not args.context_revision or not NATIVE.fullmatch(args.context_revision):
            raise ValueError("Realm context references differ")
    else:
        raise ValueError("invalid context kind")
    if args.predecessor and not NATIVE.fullmatch(args.predecessor):
        raise ValueError("invalid predecessor")
    identities = [getattr(args, key) for key in refs]
    if args.context_kind == "realm":
        identities.extend((args.context, args.realm, args.context_revision))
    if args.predecessor:
        identities.append(args.predecessor)
    if len(set(identities)) != len(identities) - int(args.proposer == args.decider):
        raise ValueError("classification references must be distinct except proposer/decider")
    if data.stat().st_size > 65536:
        raise ValueError("classification decision candidate exceeds 64 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("classification-direct-decision-v1 shape digest changed without profile review")
    env = os.environ.copy()
    env["JAVA_HOME"] = str(args.java_home)
    java = subprocess.check_output([str(args.java_home / "bin" / "java"), "-version"],
                                   stderr=subprocess.STDOUT, text=True)
    if 'version "21.' not in java:
        raise ValueError("this profile is pinned to Java 21")
    version = subprocess.check_output([str(args.jena_home / "bin" / "shacl"), "--version"],
                                      env=env, stderr=subprocess.STDOUT, text=True).strip()
    if version != "Apache Jena SHACL version 6.2.0":
        raise ValueError(f"unexpected Jena SHACL build: {version}")

    foci = {"work": args.work, "main": args.main, "sense": args.sense,
            "context": args.context, "application": args.application, "decision": args.decision}
    dynamic = "".join(f"\n<{BASE}/{role}-shape> <{SH}targetNode> <{value}> ."
                      for role, value in foci.items())
    dynamic += f"\n<{BASE}/global-shape> a <{SH}NodeShape> ; <{SH}targetNode> <{GLOBAL}> ."
    global_shape = f"{BASE}/global-shape"
    dynamic += (f"\n<{global_shape}> <{SH}property> [ <{SH}path> "
                f"<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ; "
                f"<{SH}hasValue> <{RV}ClassificationContext> ] .")
    for predicate, value in (("contextRole", RV + "GlobalClassification"),
                             ("contextState", RV + "Active"),
                             ("inheritancePolicy", ISOLATE)):
        dynamic += property_rule(global_shape, predicate, value=value)
    for predicate in ("realm", "fallbackContext"):
        dynamic += property_rule(global_shape, predicate, absent=True)

    bound = {
        "work": (("mainVersion", args.main),),
        "main": (("work", args.work),),
        "sense": (("head", args.sense_revision),),
        "application": (("targetMainVersion", args.main), ("sense", args.sense),
                        ("classificationContext", args.context), ("applicationKey", args.slot),
                        ("proposer", args.proposer), ("decisionHead", args.decision)),
        "decision": (("application", args.application),
                     ("outcome", RV + ("Accepted" if args.outcome == "accepted" else "Rejected")),
                     ("decisionBasis", RV + ("GlobalCuratorReview" if args.context_kind == "global"
                                               else "RealmManagerReview")),
                     ("decidedBy", args.decider)),
    }
    for role, pairs in bound.items():
        for predicate, value in pairs:
            dynamic += property_rule(f"{BASE}/{role}-shape", predicate, value=value)
    context_shape = f"{BASE}/context-shape"
    dynamic += property_rule(context_shape, "contextRole", value=RV + (
        "GlobalClassification" if args.context_kind == "global" else "RealmClassification"))
    dynamic += property_rule(context_shape, "inheritancePolicy", value=(
        ISOLATE if args.context_kind == "global" else INHERIT))
    if args.context_kind == "realm":
        for predicate, value in (("realm", args.realm), ("fallbackContext", GLOBAL),
                                 ("head", args.context_revision)):
            dynamic += property_rule(context_shape, predicate, value=value)
        realm_shape = f"{BASE}/realm-shape"
        dynamic += f"\n<{realm_shape}> a <{SH}NodeShape> ; <{SH}targetNode> <{args.realm}> ."
        dynamic += (f"\n<{realm_shape}> <{SH}property> [ <{SH}path> "
                    f"<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ; "
                    f"<{SH}hasValue> <{RV}Realm> ] .")
        for predicate, value in (("realmState", RV + "Active"),
                                 ("classificationContext", args.context)):
            dynamic += property_rule(realm_shape, predicate, value=value)
    else:
        for predicate in ("realm", "fallbackContext", "head"):
            dynamic += property_rule(context_shape, predicate, absent=True)
    decision_shape = f"{BASE}/decision-shape"
    if args.context_revision:
        dynamic += property_rule(decision_shape, "contextRevision", value=args.context_revision)
    else:
        dynamic += property_rule(decision_shape, "contextRevision", absent=True)
    if args.predecessor:
        dynamic += property_rule(decision_shape, "predecessor", value=args.predecessor)
    else:
        dynamic += property_rule(decision_shape, "predecessor", absent=True)

    with tempfile.TemporaryDirectory(prefix="classification-decision-shape-",
                                     dir=args.temp_root) as dirname:
        shape_file = Path(dirname) / "shapes.ttl"
        shape_file.write_bytes(shapes + dynamic.encode())
        completed = subprocess.run([str(args.jena_home / "bin" / "shacl"), "validate",
                                    "--shapes", str(shape_file), "--data", str(data)],
                                   env=env, capture_output=True, text=True, timeout=20)
    if completed.returncode != 0:
        raise RuntimeError(f"Jena SHACL failed: {completed.stderr or completed.stdout}")
    matches = re.findall(r"\bsh:conforms\s+(true|false)\b", completed.stdout)
    if "sh:ValidationReport" not in completed.stdout or len(matches) != 1:
        raise RuntimeError(f"Unexpected Jena SHACL report: {completed.stdout}")
    conforms = matches[0] == "true"
    if not conforms and ("sh:result" not in completed.stdout or
                         "sh:focusNode" not in completed.stdout):
        raise RuntimeError(f"Incomplete Jena SHACL violation report: {completed.stdout}")
    return {"profile": "classification-direct-decision-v1", "profile_sha256": PROFILE_SHA256,
            "jena_shacl": version, "context_kind": args.context_kind,
            "conforms": conforms, "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    for key in ("work", "main", "sense", "sense-revision", "context", "application",
                "decision", "slot", "proposer", "decider", "outcome"):
        parser.add_argument(f"--{key}", required=True)
    parser.add_argument("--context-kind", choices=("global", "realm"), required=True)
    parser.add_argument("--realm")
    parser.add_argument("--context-revision")
    parser.add_argument("--predecessor")
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    args.jena_home = args.jena_home.resolve(strict=True)
    args.java_home = args.java_home.resolve(strict=True)
    args.temp_root = args.temp_root.resolve(strict=True)
    report = validate(args.data.resolve(strict=True), args)
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

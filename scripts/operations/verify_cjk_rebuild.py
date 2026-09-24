#!/usr/bin/env python3
"""Qualify a stopped StandardAnalyzer-to-CJK index rebuild on disposable data."""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess

from verify_graph_substrate import (
    FUSEKI_620_SHA512, bindings, free_port, query, sha512, start, stop, update,
)


GRAPH = "urn:rezics:search:public"
PREDICATE = "https://rezics.com/vocab/searchBody"
CURRENT = "urn:rezics:rebuild:current"
DELETED = "urn:rezics:rebuild:deleted"
BODY = "中文检索验证，東京図書館で한국어 자료を探す。Galaxy42 混合标识。"
OLD_ANALYZER = re.compile(
    r'text:analyzer \[ a text:GenericAnalyzer ;\s*'
    r'text:class "org\.apache\.lucene\.analysis\.cjk\.CJKAnalyzer" \] ;\s*'
    r'text:queryAnalyzer \[ a text:GenericAnalyzer ;\s*'
    r'text:class "org\.apache\.lucene\.analysis\.cjk\.CJKAnalyzer" \] ;',
)


def text_hits(port, phrase):
    return bindings(query(port, f'''SELECT ?unit ?literal ?graph WHERE {{
      GRAPH <{GRAPH}> {{
        (?unit ?score ?literal ?graph) text:query (<{PREDICATE}> "{phrase}") .
      }}
    }}'''))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fuseki-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--assembler", type=Path, required=True)
    parser.add_argument("--fuseki-archive", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True, help="new disposable output directory")
    args = parser.parse_args()
    assert not args.state.exists(), f"Refusing to reuse {args.state}"
    fuseki_home = args.fuseki_home.resolve(strict=True)
    java_home = args.java_home.resolve(strict=True)
    assembler = args.assembler.resolve(strict=True)
    archive = args.fuseki_archive.resolve(strict=True)
    assert sha512(archive) == FUSEKI_620_SHA512, "Fuseki archive checksum mismatch"
    java_version = subprocess.check_output(
        [str(java_home / "bin" / "java"), "-version"],
        stderr=subprocess.STDOUT, text=True,
    ).splitlines()[0]
    assert 'version "21.' in java_version, java_version
    cjk_config = assembler.read_text()
    old_config, replacements = OLD_ANALYZER.subn(
        "text:analyzer [ a text:StandardAnalyzer ] ;", cjk_config,
    )
    assert replacements == 1 and old_config != cjk_config, "CJK assembler profile differs"
    state = args.state.resolve()
    base = state / "run"
    index = base / "databases" / "rezics" / "lucene"
    (base / "databases" / "rezics" / "tdb2").mkdir(parents=True, mode=0o700)
    index.mkdir(parents=True, mode=0o700)
    config = base / "fuseki-text.ttl"
    config.write_text(old_config)
    evidence = {
        "cases": ["SEARCH06", "SEARCH15", "OPS16-index-rebuild"],
        "java": java_version,
        "fuseki_archive_sha512": FUSEKI_620_SHA512,
        "old_assembler_sha512": sha512(config),
        "new_assembler_sha512": sha512(assembler),
        "checks": {},
    }
    proc = None
    try:
        port = free_port()
        proc = start(fuseki_home, java_home, base, port, state / "standard.log")
        update(port, f'''INSERT DATA {{ GRAPH <{GRAPH}> {{
          <{CURRENT}> <{PREDICATE}> "{BODY}"@zh .
          <{DELETED}> <{PREDICATE}> "stale rebuild probe"@en .
        }} }}''')
        update(port, f'''DELETE DATA {{ GRAPH <{GRAPH}> {{
          <{DELETED}> <{PREDICATE}> "stale rebuild probe"@en .
        }} }}''')
        before = bindings(query(port, f'''SELECT ?body WHERE {{
          GRAPH <{GRAPH}> {{ <{CURRENT}> <{PREDICATE}> ?body }}
        }}'''))
        assert len(before) == 1 and before[0]["body"]["value"] == BODY, before
        evidence["checks"]["source_graph"] = {
            "current_literal": BODY,
            "deleted_triple_absent": bindings(query(port, f'''SELECT ?body WHERE {{
              GRAPH <{GRAPH}> {{ <{DELETED}> <{PREDICATE}> ?body }}
            }}''')) == [],
        }
        assert evidence["checks"]["source_graph"]["deleted_triple_absent"]
        stop(proc)
        proc = None

        old_index = base / "databases" / "rezics" / "lucene-standard-v0"
        shutil.move(index, old_index)
        index.mkdir()
        config.write_text(cjk_config)
        assert sha512(config) == evidence["new_assembler_sha512"]
        # Fuseki and Main remain stopped while the old index is quarantined.
        with (state / "indexer.log").open("wb") as log:
            subprocess.run(
                [str(java_home / "bin" / "java"), "-Xmx1g", "-cp",
                 str(fuseki_home / "fuseki-server.jar"), "jena.textindexer",
                 f"--desc={config}"],
                cwd=base, stdout=log, stderr=subprocess.STDOUT, check=True,
                timeout=90,
            )
        evidence["checks"]["offline_rebuild"] = {
            "old_index_quarantined": old_index.is_dir(),
            "replacement_index_nonempty": any(index.iterdir()),
            "fuseki_stopped_during_indexer": True,
        }
        assert evidence["checks"]["offline_rebuild"]["replacement_index_nonempty"]

        port = free_port()
        proc = start(fuseki_home, java_home, base, port, state / "cjk.log")
        hits = text_hits(port, "中文检索")
        assert len(hits) == 1, hits
        assert hits[0]["unit"]["value"] == CURRENT, hits
        assert hits[0]["literal"]["value"] == BODY, hits
        assert hits[0]["literal"]["xml:lang"] == "zh", hits
        assert hits[0]["graph"]["value"] == GRAPH, hits
        assert text_hits(port, "stale rebuild probe") == []
        evidence["checks"]["rebuilt_reader"] = {
            "chinese_hits": len(hits), "original_literal": BODY,
            "language": "zh", "graph": GRAPH, "deleted_hits": 0,
        }
        stop(proc)
        proc = None
        evidence["result"] = "pass"
    finally:
        if proc is not None and proc.poll() is None:
            stop(proc)
        (state / "result.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

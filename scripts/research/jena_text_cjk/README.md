# jena-text CJK and query-construction probes

Research evidence retained 2026-09-23 for the
[toolchain survey](../../../docs/research/toolchain-survey.md) and the
[search contract](../../../docs/contracts/search.md). These are isolated embedded
probes, not Fuseki HTTP, capacity or production acceptance.

## Environment

- `org.apache.jena:jena-fuseki-server:6.2.0` from Maven Central, SHA-1
  `d3490295a2b95677c1227d25bca8564d40f993a7`. The jar contains Lucene
  analysis-common only; ICU, smartcn, kuromoji and nori are separate modules.
- OpenJDK 25.0.4.1 single-file source launch; Rust `spargebra` 0.4.7 and
  `oxrdf` 0.3.4 (see `spargebra-roundtrip/Cargo.lock`).
- Each run creates temporary TDB2 and Lucene directories under the system temp path.

## Reproduce

Run from this directory. `lab/` is ignored by Git.

```sh
mkdir -p lab
curl -fsSL -o lab/jena-fuseki-server-6.2.0.jar \
  https://repo1.maven.org/maven2/org/apache/jena/jena-fuseki-server/6.2.0/jena-fuseki-server-6.2.0.jar
echo "d3490295a2b95677c1227d25bca8564d40f993a7  lab/jena-fuseki-server-6.2.0.jar" | sha1sum --check
java --enable-native-access=ALL-UNNAMED -cp lab/jena-fuseki-server-6.2.0.jar JenaCjkProbe.java
(cd spargebra-roundtrip && cargo run)
java --enable-native-access=ALL-UNNAMED -cp lab/jena-fuseki-server-6.2.0.jar JenaRoundTrip.java
java -Xmx3g --enable-native-access=ALL-UNNAMED -cp lab/jena-fuseki-server-6.2.0.jar JenaScale.java
```

## Observed results

Eleven fixtures cover simplified/traditional Chinese, single Han characters,
cross-word substrings, full-width Latin, Japanese, Korean and two-term input. The
expected answer is normalized substring containment. "Compiled" escapes each
whitespace-separated term, quotes it as a Lucene phrase and joins terms with `AND`.

| Analyzer profile | Raw user string | Compiled | Named-graph scope |
| --- | --- | --- | --- |
| `StandardAnalyzer` | 4/11 | 10/11; full-width text missed | works |
| `CJKAnalyzer` | 5/11 | 8/11; every single-character query missed | works |
| Unigram+bigram index with separate `text:queryAnalyzer` | 8/11 | 11/11 | **0 hits** |
| Unigram+bigram (`CJKBigramFilter`, `outputUnigrams=true`) for index and query | 10/11 | 11/11 | works |
| `StandardTokenizer` + `CJKWidthFilter` + lower case | 5/11 | 11/11 | works |

Filter completeness used 14,005 documents containing the query term, five of
which carry the target category and rank low:

| Execution | Target rows | Time |
| --- | --- | --- |
| Text first, no `text:query` limit | 0/5 (Lucene returns 10,000 hits) | 139 ms |
| Text first, explicit limit 20001 | 5/5 | 146 ms |
| Target graph as a Lucene graph-field scope, no limit | 5/5 | 3 ms |
| Graph first, per-subject `text:query` over 2,000 candidates | 2000/2000 | 2,727 ms |
| Graph first, `CONTAINS` on a normalized literal over 2,000 candidates | 2000/2000 | 14 ms |

At about 102,000 documents (`JenaScale.java`), a rare-term Lucene query took 8 ms,
materializing 102,000 common-term hits took 898 ms and a full `CONTAINS` scan took
97 ms. `spargebra` parsed, substituted and serialized `text:query` requests; Jena
returned identical subjects and scores for 3/3 requests, including an injection
string kept as one literal. Raw outputs are under `evidence/2026-09-23/`.

## Source basis and limits

The explanations come from the pinned
[TextIndexLucene](https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/TextIndexLucene.java):
`MAX_N = 10000` applies when no limit is given, the default query parser is Lucene
`QueryParser` with OR semantics, a configured query analyzer replaces the
per-field keyword analyzers used for graph/entity fields, and each query opens a
new `DirectoryReader`. Fixtures are small and synthetic. They do not qualify real
corpus relevance, highlight offsets, index size, private search, HTTP behavior,
crash recovery or capacity; timings came from one warm workstation.

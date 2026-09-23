import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

import org.apache.jena.query.*;
import org.apache.jena.rdf.model.*;
import org.apache.jena.system.Txn;
import org.apache.jena.riot.*;

/**
 * Isolated research probe for Jena 6.2.0 jena-text CJK behaviour.
 * Run from this directory: java -cp lab/jena-fuseki-server-6.2.0.jar JenaCjkProbe.java
 */
public class JenaCjkProbe {
    static final String PREFIX = """
        PREFIX text: <http://jena.apache.org/text#>
        PREFIX s: <https://example.test/search/>
        PREFIX ex: <https://example.test/>
        """;

    static String assembler(String dir, String analyzerBlock, String queryAnalyzerBlock, String defineBlock) {
        return """
            PREFIX tdb2: <http://jena.apache.org/2016/tdb#>
            PREFIX text: <http://jena.apache.org/text#>
            PREFIX s:    <https://example.test/search/>
            PREFIX :     <https://example.test/asm#>

            :ds a text:TextDataset ; text:dataset :tdb ; text:index :idx .
            :tdb a tdb2:DatasetTDB2 ; tdb2:location "%s/tdb2" .
            :idx a text:TextIndexLucene ;
                text:directory "%s/lucene" ;
                text:entityMap :em ;
                text:storeValues true ;
                %s
                %s
                text:analyzer %s .
            :em a text:EntityMap ;
                text:entityField "uri" ; text:defaultField "body" ;
                text:uidField "uid" ; text:graphField "graph" ;
                text:map ( [ text:field "body" ; text:predicate s:body ] ) .
            """.formatted(dir, dir, defineBlock, queryAnalyzerBlock, analyzerBlock);
    }

    record Profile(String name, String analyzer, String queryAnalyzer, String define) {}

    static final String CJK_UNI_DEFINE = """
        text:defineAnalyzers (
          [ text:defineAnalyzer :cjkIndex ;
            text:analyzer [ a text:ConfigurableAnalyzer ;
              text:tokenizer :std ;
              text:filters ( :width text:LowerCaseFilter :bigramUni ) ] ]
          [ text:defineTokenizer :std ;
            text:tokenizer [ a text:GenericTokenizer ;
              text:class "org.apache.lucene.analysis.standard.StandardTokenizer" ] ]
          [ text:defineFilter :width ;
            text:filter [ a text:GenericFilter ;
              text:class "org.apache.lucene.analysis.cjk.CJKWidthFilter" ] ]
          [ text:defineFilter :bigramUni ;
            text:filter [ a text:GenericFilter ;
              text:class "org.apache.lucene.analysis.cjk.CJKBigramFilter" ;
              text:params ( [ text:paramName "flags" ; text:paramType text:TypeInt ; text:paramValue 15 ]
                            [ text:paramName "outputUnigrams" ; text:paramType text:TypeBoolean ; text:paramValue true ] ) ] ]
        ) ;
        """;

    static final String STD_WIDTH_DEFINE = """
        text:defineAnalyzers (
          [ text:defineAnalyzer :stdWidth ;
            text:analyzer [ a text:ConfigurableAnalyzer ;
              text:tokenizer :std ;
              text:filters ( :width text:LowerCaseFilter ) ] ]
          [ text:defineTokenizer :std ;
            text:tokenizer [ a text:GenericTokenizer ;
              text:class "org.apache.lucene.analysis.standard.StandardTokenizer" ] ]
          [ text:defineFilter :width ;
            text:filter [ a text:GenericFilter ;
              text:class "org.apache.lucene.analysis.cjk.CJKWidthFilter" ] ]
        ) ;
        """;

    static final List<Profile> PROFILES = List.of(
        new Profile("standard", "[ a text:StandardAnalyzer ]", "", ""),
        new Profile("cjk-bigram", "[ a text:GenericAnalyzer ; text:class \"org.apache.lucene.analysis.cjk.CJKAnalyzer\" ]", "", ""),
        new Profile("cjk-uni+bi-index/bigram-query",
            "[ a text:DefinedAnalyzer ; text:useAnalyzer :cjkIndex ]",
            "text:queryAnalyzer [ a text:GenericAnalyzer ; text:class \"org.apache.lucene.analysis.cjk.CJKAnalyzer\" ] ;",
            CJK_UNI_DEFINE),
        new Profile("cjk-uni+bi-both",
            "[ a text:DefinedAnalyzer ; text:useAnalyzer :cjkIndex ]", "", CJK_UNI_DEFINE),
        new Profile("standard+width",
            "[ a text:DefinedAnalyzer ; text:useAnalyzer :stdWidth ]", "", STD_WIDTH_DEFINE)
    );

    static final String[] SCOPE_GRAPHS = {"urn:g:realmA", "https://rezics.test/realm/b"};

    // id, body, category
    static final String[][] DOCS = {
        {"d1", "我在研究中文搜索功能", "science"},
        {"d2", "今天討論中文搜尋方案", "literature"},
        {"d3", "Rust語言中文資料", "science"},
        {"d4", "人工智能检索教程", "science"},
        {"d5", "功能说明书", "manual"},
        {"d6", "青龍偃月刀", "literature"},
        {"d7", "圖書館藏書", "literature"},
        {"d8", "ＲＵＳＴ全角字母", "science"},
        {"d9", "東京の検索エンジン", "science"},
        {"d10", "한국어 검색 엔진", "science"},
    };

    // query, expected substring-semantics result, note
    static final String[][] QUERIES = {
        {"搜索", "d1", "two-char word"},
        {"搜索功能", "d1", "multi-bigram query must not match d5 (功能 only)"},
        {"中文搜", "d1,d2", "odd-length cross-word substring (d2 has 中文搜尋)"},
        {"搜寻", "", "simplified 搜寻 vs traditional 搜尋 in d2: no conversion configured, expected miss"},
        {"龍", "d6", "single Han char inside a run"},
        {"功", "d1,d5", "single Han char"},
        {"rust", "d3,d8", "latin incl. full-width ＲＵＳＴ"},
        {"検索", "d9", "Japanese kanji"},
        {"검색", "d10", "Korean"},
        {"书", "d5", "simplified 书; d7 has traditional 書 (conversion not expected)"},
        {"中文 功能", "d1", "two user terms, all must match"},
    };

    static String luceneEscape(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            if ("\\+-!():^[]\"{}~*?|&/".indexOf(c) >= 0) b.append('\\');
            b.append(c);
        }
        return b.toString();
    }

    /** Compile user input: every whitespace term becomes a phrase; all terms required. */
    static String compiled(String userInput) {
        return Arrays.stream(userInput.trim().split("\\s+"))
            .map(t -> "\"" + luceneEscape(t) + "\"")
            .collect(Collectors.joining(" AND "));
    }

    static String sparqlString(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    static Dataset open(Path root, Profile p) throws Exception {
        Path dir = root.resolve(p.name().replaceAll("[^a-z0-9]+", "_"));
        Files.createDirectories(dir);
        String ttl = assembler(dir.toString(), p.analyzer(), p.queryAnalyzer(), p.define());
        Path asm = dir.resolve("assembler.ttl");
        Files.writeString(asm, ttl);
        return DatasetFactory.assemble(asm.toString(), "https://example.test/asm#ds");
    }

    static void insertDocs(Dataset ds, String[][] docs) {
        StringBuilder sb = new StringBuilder(PREFIX + "INSERT DATA { GRAPH <urn:g:public> {\n");
        for (String[] d : docs)
            sb.append("ex:").append(d[0]).append(" s:body ").append(sparqlString(d[1]))
              .append(" ; s:norm ").append(sparqlString(java.text.Normalizer.normalize(d[1], java.text.Normalizer.Form.NFKC).toLowerCase(Locale.ROOT)))
              .append(" ; ex:cat ex:").append(d[2]).append(" .\n");
        sb.append("} }");
        Txn.executeWrite(ds, () -> org.apache.jena.update.UpdateAction.parseExecute(sb.toString(), ds));
    }

    static List<String> ids(Dataset ds, String sparql) {
        return Txn.calculateRead(ds, () -> {
            List<String> out = new ArrayList<>();
            try (QueryExecution qe = QueryExecutionFactory.create(sparql, ds)) {
                ResultSet rs = qe.execSelect();
                while (rs.hasNext()) {
                    QuerySolution qs = rs.next();
                    out.add(qs.getResource("s").getLocalName());
                }
            }
            if (sparql.contains("ORDER BY")) return out;
            return out.stream().distinct().sorted(Comparator.comparingInt(x -> Integer.parseInt(x.replaceAll("\\D", "")))).toList();
        });
    }

    static long count(Dataset ds, String sparql) {
        return Txn.calculateRead(ds, () -> {
            try (QueryExecution qe = QueryExecutionFactory.create(sparql, ds)) {
                return qe.execSelect().next().getLiteral("n").getLong();
            }
        });
    }

    static String textQuery(String luceneQuery, String limit) {
        return PREFIX + "SELECT DISTINCT ?s WHERE { GRAPH <urn:g:public> { ?s text:query (s:body "
            + sparqlString(luceneQuery) + (limit == null ? "" : " " + limit) + ") } }";
    }

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("rezics-jena-cjk-");
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("jena", "6.2.0 jena-fuseki-server jar (Maven Central sha1 d3490295a2b95677c1227d25bca8564d40f993a7)");
        report.put("java", System.getProperty("java.version"));
        List<Map<String, Object>> semantic = new ArrayList<>();

        for (Profile p : PROFILES) {
            Dataset ds = open(root, p);
            insertDocs(ds, DOCS);
            int rawPass = 0, compiledPass = 0;
            for (String[] q : QUERIES) {
                List<String> expected = q[1].isEmpty() ? List.of() : Arrays.asList(q[1].split(","));
                List<String> raw = ids(ds, textQuery(q[0], null));
                List<String> comp = ids(ds, textQuery(compiled(q[0]), null));
                boolean rOk = raw.equals(expected), cOk = comp.equals(expected);
                if (rOk) rawPass++;
                if (cOk) compiledPass++;
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("profile", p.name()); row.put("query", q[0]); row.put("note", q[2]);
                row.put("expected", expected); row.put("raw", raw); row.put("compiled", comp);
                row.put("compiledLucene", compiled(q[0]));
                semantic.add(row);
                System.out.printf("%-30s %-8s raw=%s%-14s compiled=%s%-14s expected=%s%n",
                    p.name(), q[0], rOk ? "OK " : "BAD", raw, cOk ? "OK " : "BAD", comp, expected);
            }
            Map<String, Object> scopes = new LinkedHashMap<>();
            for (String g : SCOPE_GRAPHS) {
                String ins = PREFIX + "INSERT DATA { GRAPH <" + g + "> { ex:g1 s:body \"范围内的中文搜索\" . ex:g2 s:body \"范围内的中文搜索二\" } }";
                Txn.executeWrite(ds, () -> org.apache.jena.update.UpdateAction.parseExecute(ins, ds));
                String q = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <" + g + "> { ?s text:query (s:body " + sparqlString(compiled("搜索")) + ") } }";
                scopes.put(g, count(ds, q));
            }
            System.out.printf("== %s: raw %d/%d, compiled %d/%d, namedGraphScope(expect 2 each)=%s%n%n", p.name(), rawPass, QUERIES.length, compiledPass, QUERIES.length, scopes);
            report.put("summary_" + p.name(), Map.of("raw", rawPass, "compiled", compiledPass, "total", QUERIES.length, "namedGraphScope", scopes));
            ds.close();
        }
        report.put("semantic", semantic);

        // ---- Filter completeness against Lucene hit cap ----
        Profile best = PROFILES.get(3);
        report.put("filterCompletenessProfile", best.name());
        Dataset ds = open(root.resolve("cap"), best);
        int nOther = 12000, nMid = 2000, nTarget = 5;
        List<String[]> big = new ArrayList<>();
        int i = 0;
        for (int k = 0; k < nOther; k++, i++) big.add(new String[]{"b" + i, "中文资料第" + k + "篇", "other"});
        for (int k = 0; k < nMid; k++, i++) big.add(new String[]{"b" + i, "中文资料中册第" + k + "篇", "mid"});
        String pad = "这是一段很长的补充说明文字用于降低相关度评分".repeat(8);
        for (int k = 0; k < nTarget; k++, i++) big.add(new String[]{"b" + i, "中文" + pad + k, "target"});
        long t0 = System.nanoTime();
        for (int from = 0; from < big.size(); from += 2000)
            insertDocs(ds, big.subList(from, Math.min(big.size(), from + 2000)).toArray(new String[0][]));
        long loadMs = (System.nanoTime() - t0) / 1_000_000;
        String phrase = sparqlString("\"中文\"");
        Map<String, Object> cap = new LinkedHashMap<>();
        cap.put("corpus", Map.of("other", nOther, "mid", nMid, "target", nTarget, "loadMs", loadMs));

        String textFirstNoLimit = PREFIX + "SELECT ?s WHERE { GRAPH <urn:g:public> { ?s text:query (s:body " + phrase + ") . ?s ex:cat ex:target } }";
        String textFirstBig = PREFIX + "SELECT ?s WHERE { GRAPH <urn:g:public> { ?s text:query (s:body " + phrase + " 20001) . ?s ex:cat ex:target } }";
        String graphFirst = PREFIX + "SELECT ?s WHERE { GRAPH <urn:g:public> { ?s ex:cat ex:target . ?s text:query (s:body " + phrase + ") } }";
        String graphFirstMid = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s ex:cat ex:mid . ?s text:query (s:body " + phrase + ") } }";
        String hitCountBudget = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s text:query (s:body " + phrase + " 20001) } }";
        String hitCountDefault = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s text:query (s:body " + phrase + ") } }";
        String sortedGraphFirst = PREFIX + "SELECT ?s ?score WHERE { GRAPH <urn:g:public> { ?s ex:cat ex:target . (?s ?score) text:query (s:body " + phrase + ") } } ORDER BY DESC(?score) ?s";

        cap.put("hitCount_default", count(ds, hitCountDefault));
        cap.put("hitCount_limit20001", count(ds, hitCountBudget));
        long a = System.nanoTime(); List<String> r1 = ids(ds, textFirstNoLimit); long a1 = System.nanoTime();
        List<String> r2 = ids(ds, textFirstBig); long a2 = System.nanoTime();
        List<String> r3 = ids(ds, graphFirst); long a3 = System.nanoTime();
        long midCount = count(ds, graphFirstMid); long a4 = System.nanoTime();
        List<String> r5 = ids(ds, sortedGraphFirst);
        cap.put("textFirst_noLimit_targetFound", r1.size());
        cap.put("textFirst_noLimit_ms", (a1 - a) / 1_000_000);
        cap.put("textFirst_limit20001_targetFound", r2.size());
        cap.put("textFirst_limit20001_ms", (a2 - a1) / 1_000_000);
        cap.put("graphFirst_targetFound", r3.size());
        cap.put("graphFirst_target_ms", (a3 - a2) / 1_000_000);
        cap.put("graphFirst_mid2000_count", midCount);
        cap.put("graphFirst_mid2000_ms", (a4 - a3) / 1_000_000);
        cap.put("graphFirst_sorted", r5);

        String containsMid = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s ex:cat ex:mid ; s:norm ?t FILTER(CONTAINS(?t, \"中文\")) } }";
        String containsTarget = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s ex:cat ex:target ; s:norm ?t FILTER(CONTAINS(?t, \"中文\")) } }";
        String containsAll = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s s:norm ?t FILTER(CONTAINS(?t, \"中文\")) } }";
        count(ds, containsMid); // warm-up
        long c0 = System.nanoTime(); long cm = count(ds, containsMid); long c1 = System.nanoTime();
        long ct = count(ds, containsTarget); long c2 = System.nanoTime();
        long ca = count(ds, containsAll); long c3 = System.nanoTime();
        cap.put("graphFirstContains_mid2000", List.of(cm, (c1 - c0) / 1_000_000));
        cap.put("graphFirstContains_target", List.of(ct, (c2 - c1) / 1_000_000));
        cap.put("fullScanContains_all", List.of(ca, (c3 - c2) / 1_000_000));

        // One mandatory scope as a named graph: Lucene applies the graph field before its hit cap.
        StringBuilder scoped = new StringBuilder(PREFIX + "INSERT DATA { GRAPH <urn:g:realmA> {\n");
        for (int k = 0; k < nTarget; k++) scoped.append("ex:r").append(k).append(" s:body ").append(sparqlString("中文" + pad + k)).append(" .\n");
        scoped.append("} }");
        Txn.executeWrite(ds, () -> org.apache.jena.update.UpdateAction.parseExecute(scoped.toString(), ds));
        String graphScoped = PREFIX + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:realmA> { ?s text:query (s:body " + phrase + ") } }";
        long b0 = System.nanoTime();
        cap.put("namedGraphScope_noLimit_found", count(ds, graphScoped));
        cap.put("namedGraphScope_ms", (System.nanoTime() - b0) / 1_000_000);
        report.put("filterCompleteness", cap);
        System.out.println("filter completeness: " + cap);
        ds.close();

        Path out = Path.of("evidence/2026-09-23/jena-result.json");
        Files.writeString(out, toJson(report) + "\n");
        System.out.println("Evidence: " + out.toAbsolutePath() + " (temp data: " + root + ")");
    }

    static String toJson(Object o) {
        if (o == null) return "null";
        if (o instanceof String s) return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        if (o instanceof Number || o instanceof Boolean) return o.toString();
        if (o instanceof Map<?, ?> m) return m.entrySet().stream().map(e -> toJson(String.valueOf(e.getKey())) + ": " + toJson(e.getValue())).collect(Collectors.joining(", ", "{", "}"));
        if (o instanceof Collection<?> c) return c.stream().map(JenaCjkProbe::toJson).collect(Collectors.joining(", ", "[", "]"));
        return toJson(o.toString());
    }
}

package com.rezics.jena;

import static org.junit.Assert.*;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.List;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextIndex;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.query.text.TextQuery;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.analysis.cjk.CJKAnalyzer;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Actual ARQ property functions and the product Lucene wrapper; no HTTP warmup. */
public class TextReadinessProbeTest {
    private static final String GRAPH = "urn:rezics:search:probe";
    private static final String PROBE = "urn:rezics:search:probe:cjk-bigram-v1";
    private static final String BODY = "中文检索验证 魔法禁書目錄 ガラス ＲＵＳＴ";
    private static final List<String> PHRASES = List.of("中文检索", "魔法禁书目录", "がらす", "ｶﾞﾗｽ", "rust");
    private static final String PREDICATE = "https://rezics.com/vocab/searchBody";
    private static String literal(String value) { return NodeFmtLib.strNT(NodeFactory.createLiteralString(value)); }
    private static String original() { return NodeFmtLib.strNT(NodeFactory.createLiteralLang(BODY, "zh")); }
    private static String conjunction(List<String> phrases) {
        return String.join(" AND ", phrases.stream().map(phrase -> "\"" + phrase + "\"").toList());
    }
    private static String pattern(List<String> queries) {
        StringBuilder result = new StringBuilder("PREFIX text: <http://jena.apache.org/text#> ASK { GRAPH <")
            .append(GRAPH).append("> { <").append(PROBE).append("> <").append(PREDICATE).append("> ")
            .append(original()).append(" . ");
        for (int n = 0; n < queries.size(); n++) result.append("(<").append(PROBE)
            .append("> ?score").append(n).append(" ?literal").append(n).append(" ?graph").append(n)
            .append(") text:query (<").append(PREDICATE).append("> ").append(literal(queries.get(n))).append(" 2) . ")
            .append("FILTER(?literal").append(n).append(" = ").append(original()).append(" && ?graph")
            .append(n).append(" = <").append(GRAPH).append(">) ");
        return result.append("} }").toString();
    }

    private static final class Fixture implements AutoCloseable {
        final org.apache.jena.sparql.core.DatasetGraph data = DatasetGraphFactory.createTxnMem();
        final TextIndexLucene lucene;
        final FilteredGraphTextIndex index;
        int searches;
        Fixture(Analyzer analyzer) {
            TextQuery.init();
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", NodeFactory.createURI(PREDICATE));
            definition.setLangField("lang");
            definition.setUidField("uid");
            var config = new TextIndexConfig(definition);
            config.setValueStored(true);
            config.setAnalyzer(analyzer);
            lucene = new TextIndexLucene(new ByteBuffersDirectory(), config);
            index = new FilteredGraphTextIndex(lucene);
            TextIndex measured = (TextIndex) Proxy.newProxyInstance(TextIndex.class.getClassLoader(),
                new Class<?>[] { TextIndex.class }, (proxy, method, arguments) -> {
                    if (method.getName().equals("query")) searches++;
                    try { return method.invoke(index, arguments); }
                    catch (InvocationTargetException failure) { throw failure.getCause(); }
                });
            data.getContext().set(TextQuery.textIndex, measured);
            data.begin(ReadWrite.WRITE);
            try {
                data.add(NodeFactory.createURI(GRAPH), NodeFactory.createURI(PROBE),
                    NodeFactory.createURI(PREDICATE), NodeFactory.createLiteralLang(BODY, "zh"));
                data.commit();
            } finally { data.end(); }
        }
        void document(String subject, String graph, String body, String language) {
            var entity = new Entity(subject, graph, language, null);
            entity.put("body", body);
            lucene.addEntity(entity);
        }
        boolean matches(List<String> queries) {
            lucene.commit();
            searches = 0;
            data.begin(ReadWrite.READ);
            try (var execution = QueryExecution.create(pattern(queries), DatasetFactory.wrap(data))) {
                return execution.execAsk();
            } finally { data.end(); }
        }
        @Override public void close() { data.close(); index.close(); }
    }

    @Test public void allFoldingWitnessesUseOneSearchBeforeAndAfterUnrelatedIndexGrowth() {
        try (Analyzer analyzer = new FilteredGraphTextAssembler.CjkBigramV2(); var fixture = new Fixture(analyzer)) {
            fixture.document(PROBE, GRAPH, BODY, "zh");
            var separate = PHRASES.stream().map(phrase -> "\"" + phrase + "\"").toList();
            assertTrue(fixture.matches(separate));
            assertEquals("the prior readiness shape performs five native searches", 5, fixture.searches);
            for (int pass = 0; pass < 2; pass++) {
                assertTrue(fixture.matches(List.of(conjunction(PHRASES))));
                assertEquals("all analyzer behaviors share one query parse and reader acquisition", 1, fixture.searches);
                if (pass == 0) for (int n = 0; n < 128; n++)
                    fixture.document("urn:test:readiness:other:" + n, GRAPH, BODY, "zh");
            }
        }
    }

    @Test public void everyConjunctIsRequiredAndTheOldAnalyzerRemainsUnready() {
        try (Analyzer analyzer = new FilteredGraphTextAssembler.CjkBigramV2(); var fixture = new Fixture(analyzer)) {
            fixture.document(PROBE, GRAPH, BODY, "zh");
            for (int n = 0; n < PHRASES.size(); n++) {
                var missing = new java.util.ArrayList<>(PHRASES);
                missing.set(n, "absent readiness phrase");
                assertFalse("conjunct " + n + " cannot be omitted", fixture.matches(List.of(conjunction(missing))));
                assertEquals(1, fixture.searches);
            }
        }
        try (Analyzer old = new CJKAnalyzer(); var fixture = new Fixture(old)) {
            fixture.document(PROBE, GRAPH, BODY, "zh");
            assertFalse(fixture.matches(List.of(conjunction(PHRASES))));
        }
    }

    @Test public void otherSubjectsGraphsLanguagesAndLiteralValuesCannotSupplyTheWitness() {
        for (String[] document : List.of(
                new String[] { "urn:test:other-probe", GRAPH, BODY, "zh" },
                new String[] { PROBE, "urn:test:other-graph", BODY, "zh" },
                new String[] { PROBE, GRAPH, BODY, "en" },
                new String[] { PROBE, GRAPH, BODY + " extra", "zh" })) {
            try (Analyzer analyzer = new FilteredGraphTextAssembler.CjkBigramV2(); var fixture = new Fixture(analyzer)) {
                fixture.document(document[0], document[1], document[2], document[3]);
                assertFalse(java.util.Arrays.toString(document), fixture.matches(List.of(conjunction(PHRASES))));
            }
        }
    }
}

package com.rezics.jena;

import static org.junit.Assert.*;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.analysis.cjk.CJKAnalyzer;
import org.apache.lucene.analysis.tokenattributes.CharTermAttribute;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class g585AnalyzerTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String GRAPH = CommandPolicy.PUBLIC_SEARCH;
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static final Node BODY = uri(RV + "searchBody");
    private static final List<String> TITLES = List.of("魔法禁書目錄", "魔法禁书目录", "魔法禁書索引",
        "かたかな", "カタカナ", "ｶﾀｶﾅ", "ガラス", "がらす", "ｶﾞﾗｽ", "か\u3099らす",
        "カラス", "キャンパス", "キヤンパス", "ＲＵＳＴ", "rust");
    private static String language(int n) { return n < 3 ? (n == 1 ? "zh-Hans" : "zh-Hant") : n < 13 ? "ja" : "en"; }

    private static final class ManagedIndex extends TextIndexLucene implements AutoCloseable {
        ManagedIndex(TextIndexConfig config) { super(new ByteBuffersDirectory(), config); }
    }

    private static ManagedIndex index(Analyzer analyzer) {
        EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
        definition.set("label", uri("http://www.w3.org/2000/01/rdf-schema#label"));
        definition.set("body", BODY);
        definition.set("publicTitle", uri(RV + "publicTitle"));
        definition.set("privateBody", uri(RV + "privateSearchBody"));
        definition.setLangField("lang");
        definition.setUidField("uid");
        TextIndexConfig config = new TextIndexConfig(definition);
        config.setValueStored(true);
        config.setAnalyzer(analyzer);
        return new ManagedIndex(config);
    }

    private static void add(TextIndexLucene index, int n, String field) {
        Entity entity = new Entity("urn:rezics:g585:" + n, GRAPH, language(n), null);
        entity.put(field, TITLES.get(n));
        index.addEntity(entity);
    }

    private static void matches(TextIndexLucene index, String field, String query, Integer... expected) {
        Node predicate = field.equals("label") ? uri("http://www.w3.org/2000/01/rdf-schema#label")
            : uri(RV + (field.equals("body") ? "searchBody" : field.equals("privateBody") ? "privateSearchBody" : "publicTitle"));
        var hits = new FilteredGraphTextIndex(index).query(predicate, "\"" + query + "\"", GRAPH, null, 100);
        assertEquals(field + ": " + query, Set.of(expected).stream().map(n -> "urn:rezics:g585:" + n)
            .collect(Collectors.toSet()), hits.stream().map(hit -> hit.getNode().getURI()).collect(Collectors.toSet()));
        for (var hit : hits) {
            int n = Integer.parseInt(hit.getNode().getURI().substring("urn:rezics:g585:".length()));
            assertEquals(TITLES.get(n), hit.getLiteral().getLiteralLexicalForm());
            assertEquals(language(n).toLowerCase(java.util.Locale.ROOT),
                hit.getLiteral().getLiteralLanguage().toLowerCase(java.util.Locale.ROOT));
        }
    }

    @Test public void bidirectionalScriptKanaWidthAndOriginalValuesAcrossEveryMappedField() {
        try (Analyzer analyzer = new FilteredGraphTextAssembler.CjkBigramV2(); ManagedIndex index = index(analyzer)) {
            for (int n = 0; n < TITLES.size(); n++) for (String field : List.of("label", "body", "publicTitle", "privateBody")) add(index, n, field);
            index.commit();
            for (String field : List.of("label", "body", "publicTitle", "privateBody")) {
                matches(index, field, "魔法禁书目录", 0, 1);
                matches(index, field, "魔法禁書目錄", 0, 1);
                matches(index, field, "魔法禁书索引", 2);
                for (String query : List.of("かたかな", "カタカナ", "ｶﾀｶﾅ")) matches(index, field, query, 3, 4, 5);
                for (String query : List.of("ガラス", "がらす", "ｶﾞﾗｽ", "か\u3099らす")) matches(index, field, query, 6, 7, 8, 9);
                matches(index, field, "からす", 10);
                matches(index, field, "きゃんぱす", 11);
                matches(index, field, "きやんぱす", 12);
                matches(index, field, "RUST", 13, 14);
                matches(index, field, "ＲＵＳＴ", 13, 14);
                matches(index, field, "katakana");
                matches(index, field, "魔法禁書目録外伝");
            }
        }
    }

    private static List<String> tokens(Analyzer analyzer, String input) throws Exception {
        try (var stream = analyzer.tokenStream("body", input)) {
            var term = stream.addAttribute(CharTermAttribute.class);
            var result = new java.util.ArrayList<String>();
            stream.reset();
            while (stream.incrementToken()) result.add(term.toString());
            stream.end();
            return result;
        }
    }

    @Test public void normalizationPrecedesBigramsAndAnalyzerReuseDoesNotCarryState() throws Exception {
        try (Analyzer analyzer = new FilteredGraphTextAssembler.CjkBigramV2()) {
            assertEquals(List.of("魔法", "法禁", "禁书", "书目", "目录"), tokens(analyzer, "魔法禁書目錄"));
            assertEquals(List.of("ガラ", "ラス"), tokens(analyzer, "ｶﾞﾗｽ"));
            assertEquals(tokens(analyzer, "ガラス"), tokens(analyzer, "がらす"));
            assertEquals(List.of("东京", "京ガ", "ガラ", "ラス"), tokens(analyzer, "東京がらす"));
            assertEquals(List.of("rust"), tokens(analyzer, "ＲＵＳＴ"));
            assertEquals("魔法禁书目录ガラス", analyzer.normalize("body", "魔法禁書目錄ｶﾞﾗｽ").utf8ToString());
            assertEquals(List.of(), tokens(analyzer, ""));
            assertEquals(List.of("ガラ", "ラス"), tokens(analyzer, "か\u3099らす"));
        }
    }

    @Test public void oldIndexCannotMatchFoldedQueryAndReplacementQualifiesThroughG556() {
        var rdf = DatasetGraphFactory.createTxnMem();
        Node control = uri(CommandPolicy.CONTROL), product = uri("urn:rezics:dataset:product");
        String generation = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";
        rdf.begin(ReadWrite.WRITE);
        try {
            rdf.add(control, product, uri(RV + "dataEpoch"), NodeFactory.createLiteralString("epoch"));
            rdf.add(control, product, uri(RV + "routingEpoch"), NodeFactory.createLiteralString("routing"));
            rdf.add(control, product, uri(RV + "sequence"), NodeFactory.createLiteralByValue(
                java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            rdf.add(control, product, uri(RV + "textIndexGeneration"), uri(generation));
            rdf.add(uri(GRAPH), uri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), uri(RV + "SearchGraphAnchor"));
            rdf.add(uri(GRAPH), uri("urn:rezics:g585:0"), RDF.type.asNode(), uri(RV + "MatchUnit"));
            rdf.add(uri(GRAPH), uri("urn:rezics:g585:0"), BODY, NodeFactory.createLiteralLang(TITLES.get(0), language(0)));
            SearchDeltaJournal.initialize(rdf);
            rdf.commit();
        } finally { rdf.end(); }
        try (Analyzer old = new CJKAnalyzer(); ManagedIndex oldIndex = index(old)) {
            add(oldIndex, 0, "body"); oldIndex.commit();
            matches(oldIndex, "body", "魔法禁书目录");
        }
        try (Analyzer analyzer = new FilteredGraphTextAssembler.CjkBigramV2(); ManagedIndex replacement = index(analyzer)) {
            replacement.commit();
            var filtered = new FilteredGraphTextIndex(replacement);
            var data = new DatasetGraphText(rdf, filtered, new TextDocProducerTriples(filtered));
            assertEquals(false, SearchDeltaJournal.qualifiedProof(data, -1, 0).get("available"));
            synchronized (data) {
                assertFalse(SearchDeltaJournal.qualify(data));
                SearchDeltaJournal.stopRecovery(data);
                add(replacement, 0, "body"); replacement.commit();
                assertTrue(SearchDeltaJournal.qualify(data));
                Map<String, Object> proof = SearchDeltaJournal.qualifiedProof(data, -1, 0);
                assertEquals(true, proof.get("available"));
                assertEquals("1", proof.get("qualifiedPopulation"));
                assertEquals(generation, proof.get("generation"));
                matches(replacement, "body", "魔法禁书目录", 0);
                // Anchor removal, as in the rebuild quarantine, closes proof.
                rdf.begin(ReadWrite.WRITE);
                try { rdf.deleteAny(uri(GRAPH), uri(CommandPolicy.PUBLIC_ANCHOR), Node.ANY, Node.ANY); rdf.commit(); }
                finally { rdf.end(); }
                assertFalse(SearchDeltaJournal.qualify(data));
                SearchDeltaJournal.stopRecovery(data);
            }
        } finally { rdf.close(); }
    }

    @Test public void profileRebuildCanOnlyReplaceTheFixedProbeWhileSearchIsQuarantined() {
        String receipt = "urn:rezics:receipt:content-rebuild:profile:" + "a".repeat(64);
        String probe = "urn:rezics:search:probe:cjk-bigram-v1";
        String update = "PREFIX rv: <" + RV + "> DELETE {"
            + " GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?n; rv:textIndexProfile ?oldProfile }"
            + " GRAPH <" + CommandPolicy.PROBE_SEARCH + "> { <" + probe + "> rv:searchBody ?oldBody } }"
            + " INSERT { GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?next;"
            + " rv:textIndexProfile <https://rezics.com/definition/search-index-cjk-bigram-v3> }"
            + " GRAPH <" + CommandPolicy.PROBE_SEARCH + "> { <" + probe + "> rv:searchBody \"魔法禁書目錄 ガラス\"@zh }"
            + " GRAPH <" + CommandPolicy.RECEIPTS + "> { <" + receipt + "> a rv:OperationReceipt }"
            + " GRAPH <" + CommandPolicy.OUTBOX + "> { <urn:rezics:g585:batch> rv:sequence ?next } }"
            + " WHERE { GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?n } BIND(?n + 1 AS ?next) }";
        var plan = CommandPolicy.parse(update, receipt);
        assertTrue(plan.rebuild());
        assertFalse(plan.bootstrap());
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(update.replace(probe, "urn:other:probe"), receipt));
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(update.replace("rv:searchBody", "rv:publicTitle"), receipt));
        String wrongPhase = receipt.replace(":profile:", ":cleared:");
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(update.replace(receipt, wrongPhase), wrongPhase));
        var data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            Node control = uri(CommandPolicy.CONTROL), product = uri("urn:rezics:dataset:product");
            data.add(control, product, uri(RV + "dataEpoch"), NodeFactory.createLiteralString("epoch"));
            data.add(control, product, uri(RV + "routingEpoch"), NodeFactory.createLiteralString("routing"));
            data.add(control, product, uri(RV + "sequence"), NodeFactory.createLiteralByValue(
                java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            data.add(uri(GRAPH), uri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), uri(RV + "SearchGraphAnchor"));
            assertEquals("rebuild quarantine state differs", CommandInvariant.preflight(data, receipt, plan));
            data.deleteAny(uri(GRAPH), uri(CommandPolicy.PUBLIC_ANCHOR), Node.ANY, Node.ANY);
            assertNull(CommandInvariant.preflight(data, receipt, plan));
        } finally { data.abort(); data.end(); data.close(); }
    }
}

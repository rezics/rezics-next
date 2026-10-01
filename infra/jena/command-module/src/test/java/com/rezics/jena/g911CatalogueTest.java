package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class g911CatalogueTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node term(String value) { return uri(RV + value); }
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), CURRENT = uri(CommandPolicy.CURRENT);
    private static final class Fixture implements AutoCloseable {
        final FilteredGraphTextIndex index;
        final DatasetGraphText data;
        Fixture() {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", term("searchBody"));
            definition.set("publicTitle", term("publicTitle"));
            definition.set("privateBody", term("privateSearchBody"));
            definition.setLangField("lang"); definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            config.setAnalyzer(new FilteredGraphTextAssembler.CjkBigramV2());
            index = new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
            data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), index, new TextDocProducerTriples(index));
            data.begin(ReadWrite.WRITE);
            try {
                add("named", "Unrelated article", "Camp Lanterns", "Camp other Lanterns", "魔法禁書目錄", "ガラス", "ＲＵＳＴ");
                add("both", "Camp Lanterns", "Camp Lanterns");
                add("body", "Camp Lanterns", "Different title");
                add("hidden", "Unrelated", "Secret Camp Lanterns");
                data.delete(CURRENT, uri("urn:main:hidden"), term("selectionHead"), uri("urn:selection:hidden"));
                data.add(uri(CommandPolicy.PRIVATE_SEARCH), uri("urn:unit:private"), term("publicTitle"),
                    NodeFactory.createLiteralLang("Secret Camp Lanterns", "en"));
                data.commit();
            } finally { data.end(); }
        }
        void add(String name, String body, String... titles) {
            Node unit = uri("urn:unit:" + name), main = uri("urn:main:" + name), selection = uri("urn:selection:" + name);
            data.add(PUBLIC, unit, RDF.type.asNode(), term("MatchUnit"));
            data.add(PUBLIC, unit, term("searchBody"), NodeFactory.createLiteralLang(body, "en"));
            for (String title : titles) data.add(PUBLIC, unit, term("publicTitle"), NodeFactory.createLiteralLang(title, "en"));
            data.add(PUBLIC, unit, term("mainVersion"), main);
            data.add(PUBLIC, unit, term("selection"), selection);
            data.add(PUBLIC, unit, term("context"), main);
            data.add(PUBLIC, unit, term("language"), NodeFactory.createLiteralString("en"));
            data.add(PUBLIC, unit, term("disclosure"), term("Public"));
            data.add(CURRENT, main, term("selectionHead"), selection);
        }
        List<FilteredGraphTextIndex.RankHit> read(String phrase, int size) {
            data.begin(ReadWrite.READ);
            try {
                List<FilteredGraphTextIndex.RankHit> visible = new ArrayList<>();
                FilteredGraphTextIndex.RankAfter after = null;
                for (int page = 0; page < 20; page++) {
                    var result = index.ranked(term("searchBody"), phrase, size, after, data,
                        new FilteredGraphTextIndex.RankScope(null, null, null, true));
                    for (var hit : result.hits()) if (hit.key() != null) visible.add(hit);
                    if (!result.more()) return visible;
                    var last = result.hits().getLast();
                    after = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), result.commit(), last.document());
                }
                throw new AssertionError("ranked document cursor did not advance");
            } finally { data.end(); }
        }
        @Override public void close() { data.close(); }
    }
    @Test public void namesOutrankBodiesAndAllWordsMatchOneNameAcrossScripts() {
        try (var fixture = new Fixture()) {
            for (String query : List.of("Camp", "Camp Lanterns", "Lanterns Camp", "魔法禁书目录", "魔法禁書目錄",
                "がらす", "ｶﾞﾗｽ", "rust")) {
                var hits = fixture.read(query, 64);
                assertEquals("urn:unit:named", hits.getFirst().id());
                assertEquals(hits.size(), hits.stream().map(FilteredGraphTextIndex.RankHit::key).distinct().count());
                for (var hit : hits) if (hit.id().equals("urn:unit:body")) assertTrue(hits.getFirst().score() > hit.score());
            }
            assertTrue(fixture.read("魔法禁书目录 rust", 64).isEmpty());
            assertTrue(fixture.read("Secret", 64).isEmpty());
            assertTrue(fixture.read("Camp OR noSuchWord", 64).isEmpty());
        }
    }
    @Test public void oneDocumentPagesAdvancePastRejectedAliasesAndBodiesWithoutDuplicatingWorks() {
        try (var fixture = new Fixture()) {
            var single = fixture.read("Camp Lanterns", 1);
            assertEquals(List.of("urn:unit:named", "urn:unit:both", "urn:unit:body"),
                single.stream().map(FilteredGraphTextIndex.RankHit::id).toList());
            assertEquals(single, fixture.read("Camp Lanterns", 64));
        }
    }
    @Test public void namesOnlyRefreshMustKeepMembershipAndCopyTheExactCurrentNameRecipe() {
        var data = DatasetGraphFactory.createTxnMem();
        Node work = uri("urn:work:one"), unit = uri("urn:unit:one"), metadata = uri("urn:metadata:one");
        data.begin(ReadWrite.WRITE);
        try {
            Node title = NodeFactory.createLiteralLang("Camp Lanterns", "en");
            Node alias = NodeFactory.createLiteralLang("魔法禁書目錄", "zh-Hant");
            data.add(CURRENT, work, uri("http://www.w3.org/2000/01/rdf-schema#label"), title);
            data.add(CURRENT, work, uri("https://schema.org/alternateName"), alias);
            data.add(CURRENT, work, term("descriptiveMetadataHead"), metadata);
            data.add(uri(CommandPolicy.REVISIONS), metadata, term("metadataState"), NodeFactory.createLiteralString(
                "{\"kind\":\"header\",\"originalTitle\":null,\"localized\":[{\"title\":\"Lampes\",\"language\":\"fr\"}]}"));
            data.add(PUBLIC, unit, term("work"), work);
            for (var name : CatalogueNamePolicy.expected(data, work)) data.add(PUBLIC, unit, term("publicTitle"), name);
            var unchanged = List.of(new SearchDeltaJournal.Change(unit.getURI(), true, true));
            assertNull(CatalogueNamePolicy.check(data, "urn:receipt:names", unchanged));
            data.add(PUBLIC, unit, term("publicTitle"), NodeFactory.createLiteralLang("Not an authored name", "en"));
            assertNotNull(CatalogueNamePolicy.check(data, "urn:receipt:names", unchanged));
            assertNotNull(CatalogueNamePolicy.check(data, "urn:receipt:names",
                List.of(new SearchDeltaJournal.Change(unit.getURI(), false, true))));
            data.abort();
        } finally { data.end(); data.close(); }
    }
}

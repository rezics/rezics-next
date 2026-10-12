package com.rezics.jena;

import static org.junit.Assert.*;

import java.math.BigInteger;
import java.util.List;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecutionFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Partial retained subjects belong to cleanup inventory, not source-pin reconstruction. */
public class ContentRebuildInventoryTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL);
    private static final Node PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node UNIT = uri("urn:rezics:content:match-unit:00000000-0000-4000-8000-000000000001");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }

    private static final class Fixture implements AutoCloseable {
        final TextIndexLucene lucene;
        final FilteredGraphTextIndex index;
        final DatasetGraphText data;
        Fixture(boolean typed, boolean indexed) {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody"));
            definition.set("publicTitle", p("publicTitle"));
            definition.setLangField("lang");
            definition.setUidField("uid");
            var config = new TextIndexConfig(definition);
            config.setValueStored(true);
            lucene = new TextIndexLucene(new ByteBuffersDirectory(), config);
            index = new FilteredGraphTextIndex(lucene);
            var storage = DatasetGraphFactory.createTxnMem();
            data = new DatasetGraphText(storage, index, new TextDocProducerTriples(index));
            index.bindRankData(data);
            data.begin(ReadWrite.WRITE);
            data.add(CONTROL, PRODUCT, p("dataEpoch"), NodeFactory.createLiteralString("epoch"));
            data.add(CONTROL, PRODUCT, p("routingEpoch"), NodeFactory.createLiteralString("routing"));
            data.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(BigInteger.ZERO, XSDDatatype.XSDinteger));
            data.add(CONTROL, PRODUCT, p("textIndexGeneration"), uri("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
            data.add(PUBLIC, uri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), p("SearchGraphAnchor"));
            SearchDeltaJournal.initialize(data);
            if (typed) data.add(PUBLIC, UNIT, RDF.type.asNode(), p("MatchUnit"));
            var target = indexed ? data : storage;
            target.add(PUBLIC, UNIT, p("searchBody"), NodeFactory.createLiteralLang("retained body", "en"));
            data.commit();
            data.end();
        }
        long remainingInventory() {
            // The owner checks every retained Content subject, even without its type.
            try (var query = QueryExecutionFactory.create("SELECT (COUNT(DISTINCT ?unit) AS ?count) WHERE { GRAPH <"
                + CommandPolicy.PUBLIC_SEARCH + "> { ?unit ?predicate ?value . FILTER(STRSTARTS(STR(?unit),"
                + "\"urn:rezics:content:match-unit:\")) } }", DatasetFactory.wrap(data))) {
                return query.execSelect().next().getLiteral("count").getLong();
            }
        }
        @Override public void close() {
            if (data.isInTransaction()) { data.abort(); data.end(); }
            data.close();
        }
    }

    @Test public void untypedRetainedSubjectSurvivesEveryBulkRebuildAsInventory() {
        for (String path : List.of("rank", "rankMetadata", "journalReset", "prefix")) {
            for (boolean indexed : List.of(false, true)) try (var f = new Fixture(false, indexed)) {
                f.data.begin(ReadWrite.WRITE);
                rebuild(f, path);
                assertEquals(path, 1, f.remainingInventory());
                assertTrue(f.data.contains(PUBLIC, UNIT, p("searchBody"), Node.ANY));
                assertFalse(f.data.contains(PUBLIC, UNIT, RDF.type.asNode(), p("MatchUnit")));
                f.data.commit();
                f.data.end();
                try (var reader = DirectoryReader.open(f.lucene.getDirectory())) {
                    assertEquals(path, indexed ? 1 : 0,
                        new IndexSearcher(reader).count(new TermQuery(new Term("uri", UNIT.getURI()))));
                } catch (java.io.IOException error) { throw new AssertionError(error); }
                assertEquals(path, !indexed, SearchDeltaJournal.qualify(f.data));
            }
        }
    }

    private static void rebuild(Fixture f, String path) {
        switch (path) {
            case "rank" -> f.index.refreshRankRebuild(f.data);
            case "rankMetadata" -> FilteredGraphTextIndex.refreshRankMetadata(f.data, List.of(), true);
            case "journalReset" -> SearchDeltaJournal.append(f.data,
                new SearchDeltaJournal.Capture(f.data, true), 1);
            case "prefix" -> PublicNameProjection.rebuildPrefix(f.data);
            default -> throw new AssertionError(path);
        }
    }

    @Test public void typedMalformedUnitKeepsRequiredFieldRefusalDuringRankRebuild() {
        for (String path : List.of("rank", "rankMetadata", "journalReset")) {
            try (var f = new Fixture(true, false)) {
                f.data.begin(ReadWrite.WRITE);
                var error = assertThrows(IllegalStateException.class, () -> rebuild(f, path));
                assertEquals(path, "Content source field missing or ambiguous: field", error.getMessage());
                assertEquals(1, f.remainingInventory());
            }
        }
    }

    @Test public void qualificationRefusesIndexedMalformedSubjectsWithoutThrowing() {
        for (boolean typed : List.of(false, true)) {
            try (var f = new Fixture(typed, true)) {
                f.data.begin(ReadWrite.WRITE);
                PublicNameProjection.rebuildPrefix(f.data);
                assertEquals(1, f.remainingInventory());
                f.data.commit();
                f.data.end();
                assertFalse(SearchDeltaJournal.qualify(f.data));
                f.data.begin(ReadWrite.READ);
                var error = assertThrows(IllegalStateException.class,
                    () -> FilteredGraphTextIndex.contentBodyMetadataSource(f.data, UNIT.getURI()));
                assertEquals(typed ? "Content source field missing or ambiguous: field"
                    : "Content source type is missing: MatchUnit", error.getMessage());
            }
        }
    }
}

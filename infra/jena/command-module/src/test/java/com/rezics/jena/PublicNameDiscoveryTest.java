package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.List;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Actual native projection, ranked collector and directory; no public API or
 * live Access proof is claimed by these controlled owner facts. */
public class PublicNameDiscoveryTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node id(int value) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH),
        REVISIONS = uri(CommandPolicy.REVISIONS), LABEL = uri("https://schema.org/name");
    private static void set(DatasetGraph data, Node graph, Node subject, String predicate, Node object) {
        data.deleteAny(graph, subject, p(predicate), Node.ANY);
        if (object != null) data.add(graph, subject, p(predicate), object);
    }
    private static void resource(DatasetGraph data, Node resource, Node work, String type) {
        Node head = uri(resource.getURI() + "/revision");
        data.add(CURRENT, resource, RDF.type.asNode(), uri("http://www.w3.org/2000/01/rdf-schema#Resource"));
        data.add(CURRENT, resource, RDF.type.asNode(), uri(type));
        data.add(CURRENT, resource, p("semanticHead"), head);
        data.add(CURRENT, resource, p("semanticWork"), work);
        data.add(CURRENT, resource, LABEL, NodeFactory.createLiteralLang("Artoria Pendragon", "en"));
        data.add(CURRENT, resource, uri("https://schema.org/alternateName"), NodeFactory.createLiteralLang("Saber", "en"));
        data.add(REVISIONS, head, RDF.type.asNode(), p("SemanticRevision"));
        data.add(REVISIONS, head, RDF.type.asNode(), p("RevisionAnchor"));
        data.add(REVISIONS, head, p("component"), resource);
        data.add(REVISIONS, head, p("lifecycle"), p("Active"));
    }
    private static void work(DatasetGraph data, Node work, Node main) {
        sequence(data);
        data.add(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
        data.add(CURRENT, work, p("mainVersion"), main);
        data.add(CURRENT, main, RDF.type.asNode(), p("MainVersion"));
        data.add(CURRENT, main, p("work"), work);
        data.add(CURRENT, work, p("catalogueVisible"), NodeFactory.createLiteralByValue(true,
            org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
    }
    private static void post(DatasetGraph data, Node post, Node variant, Node publication, Node eligibility, Node revision) {
        sequence(data);
        data.add(CURRENT, post, RDF.type.asNode(), p("Post"));
        data.add(CURRENT, post, p("head"), id(999));
        data.add(CURRENT, post, uri("http://www.w3.org/2000/01/rdf-schema#label"),
            NodeFactory.createLiteralLang("Share your smallest useful prompt", "en"));
        data.add(CURRENT, variant, RDF.type.asNode(), p("ContentVariant"));
        data.add(CURRENT, variant, p("resource"), post);
        data.add(CURRENT, variant, p("contentPublicationHead"), publication);
        data.add(CURRENT, variant, p("publicSearchEligibilityHead"), eligibility);
        data.add(REVISIONS, publication, RDF.type.asNode(), p("ContentPublicationDecision"));
        data.add(REVISIONS, publication, p("resource"), post);
        data.add(REVISIONS, publication, p("contentRevision"), revision);
        data.add(REVISIONS, eligibility, RDF.type.asNode(), p("ContentSearchEligibilityDecision"));
        data.add(REVISIONS, eligibility, p("publicationDecision"), publication);
        data.add(REVISIONS, eligibility, p("disclosure"), p("Public"));
    }
    private static void sequence(DatasetGraph data) {
        // Directory ranks come from the command owner's committed position.
        data.add(uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("sequence"),
            NodeFactory.createLiteralString("1"));
    }
    private static DatasetGraphText dataset(FilteredGraphTextIndex index) {
        return new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),
            index, new TextDocProducerTriples(index));
    }
    private static FilteredGraphTextIndex index() {
        var definition = new EntityDefinition("uri", "label", "graph");
        definition.set("publicTitle", p("publicTitle")); definition.setLangField("lang"); definition.setUidField("uid");
        var config = new TextIndexConfig(definition); config.setValueStored(true);
        return new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
    }
    @Test public void genericSemanticNamesAndAliasesTraverseWithoutATypeWhitelist() {
        var index = index(); var data = dataset(index);
        data.begin(ReadWrite.WRITE);
        try {
            work(data, id(1), id(2));
            for (int n = 10; n < 80; n++) {
                resource(data, id(n), id(1), n % 2 == 0 ? "https://rezics.com/vocab/Character" : "https://example.org/CelestialBody");
                PublicNameProjection.refresh(data, id(n));
            }
            data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            var first = index.directory("resource", "newest", 64, null, data);
            assertEquals(64, first.hits().size()); assertTrue(first.more());
            var last = first.hits().getLast();
            var next = index.directory("resource", "newest", 64,
                new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), first.commit()), data);
            assertEquals(6, next.hits().size()); assertFalse(next.more());
            var seen = new java.util.HashSet<String>();
            for (var page : List.of(first, next)) for (var hit : page.hits()) {
                assertNotNull(hit.key()); assertTrue(seen.add(hit.key()));
            }
            assertEquals(70, seen.size());
            var ranked = index.ranked(p("publicTitle"), "Saber", 64, null, data,
                new FilteredGraphTextIndex.RankScope(null, null, null, false, "resource", null));
            assertTrue(ranked.more()); assertEquals(64, ranked.hits().size());
            assertTrue(ranked.hits().stream().allMatch(hit -> hit.key() != null && hit.id().contains(":resource:")));
            var restricted = index.ranked(p("publicTitle"), "Saber", 64, null, data,
                new FilteredGraphTextIndex.RankScope(null, null, null, false, "all", List.of(id(10).getURI())));
            assertEquals(1, restricted.hits().size()); assertNotNull(restricted.hits().getFirst().key());
        } finally { data.end(); data.close(); }
    }
    @Test public void currentOwnerWithdrawalDeniesStoredNamesBeforeRepair() {
        var data = org.apache.jena.sparql.core.DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            work(data, id(1), id(2)); resource(data, id(3), id(1), "https://example.org/IndependentType");
            PublicNameProjection.refresh(data, id(3)); assertTrue(PublicNameProjection.visible(data, id(3)));
            set(data, CURRENT, id(1), "catalogueVisible", null);
            assertFalse(PublicNameProjection.visible(data, id(3)));
            work(data, id(1), id(2));
            Node head = uri(id(3).getURI() + "/revision");
            for (String predicate : List.of("listing", "disclosure", "protectionHead", "mergedInto")) {
                Node value = predicate.equals("listing") ? NodeFactory.createLiteralString("unlisted")
                    : predicate.equals("disclosure") ? p("Private") : id(9);
                set(data, CURRENT, id(3), predicate, value);
                assertFalse(predicate, PublicNameProjection.visible(data, id(3)));
                set(data, CURRENT, id(3), predicate, null);
            }
            set(data, REVISIONS, head, "lifecycle", p("Retired"));
            assertFalse(PublicNameProjection.visible(data, id(3)));
            set(data, REVISIONS, head, "lifecycle", p("Active"));
            data.add(REVISIONS, head, RDF.type.asNode(), p("ErasedRevision"));
            assertFalse(PublicNameProjection.visible(data, id(3)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void postNamesRequireTheCurrentUnerasedContentEligibilityPair() {
        var index = index(); var data = dataset(index);
        data.begin(ReadWrite.WRITE);
        try {
            post(data, id(1), id(2), id(3), id(4), id(5));
            PublicNameProjection.refresh(data, id(1)); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            var page = index.ranked(p("publicTitle"), "smallest useful prompt", 10, null, data,
                new FilteredGraphTextIndex.RankScope(null, null, null, false, "post", null));
            assertEquals(1, page.hits().size()); assertNotNull(page.hits().getFirst().key());
            assertEquals(id(1).getURI(), index.directory("post", "newest", 10, null, data).hits().getFirst().key());
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            set(data, CURRENT, id(2), "contentPublicationHead", id(6));
            assertFalse(PublicNameProjection.visible(data, id(1)));
            set(data, CURRENT, id(2), "contentPublicationHead", id(3));
            set(data, CURRENT, id(2), "publicSearchEligibilityHead", id(7));
            assertFalse(PublicNameProjection.visible(data, id(1)));
            set(data, CURRENT, id(2), "publicSearchEligibilityHead", id(4));
            data.add(REVISIONS, id(5), RDF.type.asNode(), p("ErasedRevision"));
            assertFalse(PublicNameProjection.visible(data, id(1)));
            data.deleteAny(REVISIONS, id(5), RDF.type.asNode(), p("ErasedRevision"));
            assertTrue(PublicNameProjection.visible(data, id(1)));
            data.add(CURRENT, id(8), p("resource"), id(1));
            data.add(CURRENT, id(8), p("contentPublicationHead"), id(9));
            data.add(REVISIONS, id(9), p("contentRevision"), id(10));
            data.add(REVISIONS, id(10), RDF.type.asNode(), p("ErasedRevision"));
            assertFalse("An eligible sibling cannot expose erased text", PublicNameProjection.visible(data, id(1)));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void largeGenericNameRecipesRemainResumableAndClearEveryOwnerKind() {
        var data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        try {
            work(data, id(1), id(2)); resource(data, id(3), id(1), "https://example.org/IndependentType");
            for (int n = 0; n < 140; n++) data.add(CURRENT, id(3), LABEL, NodeFactory.createLiteralString("Alias " + n));
            PublicNameProjection.refresh(data, id(3)); assertFalse(PublicNameProjection.visible(data, id(3)));
            for (int n = 0; n < 8; n++) assertTrue(PublicNameProjection.repairNameLabels(data, "urn:repair:copy:" + n) <= 64);
            assertTrue(PublicNameProjection.visible(data, id(3)));
            Node unit = PublicNameProjection.nameUnit(id(3), "resource");
            assertEquals(142, org.apache.jena.atlas.iterator.Iter.count(data.find(PUBLIC, unit, p("publicTitle"), Node.ANY)));
            set(data, CURRENT, id(3), "protectionHead", id(9)); PublicNameProjection.refresh(data, id(3));
            for (int n = 0; n < 8; n++) PublicNameProjection.repairNameLabels(data, "urn:repair:clear:" + n);
            assertFalse(data.contains(PUBLIC, unit, p("publicTitle"), Node.ANY));
        } finally { data.abort(); data.end(); data.close(); }
    }
}

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
    private static String literal(String value) {
        return org.apache.jena.riot.out.NodeFmtLib.strNT(NodeFactory.createLiteralString(value));
    }
    /** Exercise the real ARQ request boundary, not a second keyword matcher. */
    private static org.apache.jena.atlas.json.JsonObject names(DatasetGraph data, String text, String mode) {
        org.apache.jena.sparql.function.FunctionRegistry.get().put("https://rezics.com/vocab/rankedText",
            FilteredGraphTextIndex.RankedFunction.class);
        var scope = new org.apache.jena.atlas.json.JsonObject(); scope.put("names", "resource");
        if (mode != null) scope.put("matchMode", mode);
        String query = "SELECT ?page WHERE { BIND(<https://rezics.com/vocab/rankedText>(<https://rezics.com/vocab/publicTitle>,"
            + literal(text) + ",64,\"\"," + literal(scope.toString()) + ") AS ?page) }";
        try (var run = org.apache.jena.query.QueryExecutionFactory.create(query, org.apache.jena.query.DatasetFactory.wrap(data))) {
            // Match the assembler binding: ARQ exposes the underlying RDF dataset.
            run.getContext().set(TextQuery.textIndex, ((DatasetGraphText) data).getTextIndex());
            var row = run.execSelect().next();
            assertTrue("Native name request must return its bounded page", row.contains("page"));
            return org.apache.jena.atlas.json.JSON.parse(row.getLiteral("page").getString());
        }
    }
    private static List<String> nameKeys(DatasetGraph data, String text, String mode) {
        var result = new java.util.ArrayList<String>();
        for (var value : names(data, text, mode).get("hits").getAsArray()) {
            var hit = value.getAsObject();
            if (!hit.get("key").isNull()) result.add(hit.get("key").getAsString().value());
        }
        return result;
    }
    private static void named(DatasetGraph data, int number, String name, String... aliases) {
        resource(data, id(number), id(1), "https://example.org/IndependentType");
        data.deleteAny(CURRENT, id(number), LABEL, Node.ANY);
        Node alternate = uri("https://schema.org/alternateName");
        data.deleteAny(CURRENT, id(number), alternate, Node.ANY);
        data.add(CURRENT, id(number), LABEL, NodeFactory.createLiteralString(name));
        for (String alias : aliases) data.add(CURRENT, id(number), alternate, NodeFactory.createLiteralString(alias));
        PublicNameProjection.refresh(data, id(number));
    }
    @Test public void literalKeywordsMatchUnorderedTitleAndAliasWordsWithinOneAuthoredName() {
        var index = index(); var data = dataset(index); data.begin(ReadWrite.WRITE);
        try {
            work(data, id(1), id(2));
            named(data, 10, "Pride and Prejudice", "The Winter Garden");
            named(data, 11, "Pride without the other word", "Prejudice");
            named(data, 12, "Unrelated", "Pride or Prejudice");
            data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            String target = PublicNameProjection.nameUnit(id(10), "resource").getURI();
            String other = PublicNameProjection.nameUnit(id(12), "resource").getURI();
            assertEquals(java.util.Set.of(target, other), new java.util.HashSet<>(nameKeys(data, "prejudice pride", "keywords")));
            assertEquals(List.of(target), nameKeys(data, "garden winter", "keywords"));
            assertTrue(nameKeys(data, "pride prejudice", "phrase").isEmpty());
            assertTrue(nameKeys(data, "pride prejudice", null).isEmpty());
            assertEquals(List.of(target), nameKeys(data, "pride and prejudice", "phrase"));
            assertTrue(nameKeys(data, "pride nonexistent", "keywords").isEmpty());
            // Operator-looking input remains literal analyzed text: OR must be present.
            assertEquals(List.of(other), nameKeys(data, "pride OR prejudice", "keywords"));
            assertTrue(nameKeys(data, "pride OR nonexistent", "keywords").isEmpty());
            assertTrue(nameKeys(data, "title:pride", "keywords").isEmpty());
            assertEquals(java.util.Set.of(target, other), new java.util.HashSet<>(nameKeys(data, "+pride -prejudice*", "keywords")));
        } finally { data.end(); data.close(); }
    }
    @Test public void nativeKeywordsNormalizeNfcAndWhitespaceAndSupportCjkAndSupplementaryCharacters() {
        var index = index(); var data = dataset(index); data.begin(ReadWrite.WRITE);
        try {
            work(data, id(1), id(2));
            named(data, 10, "Café au lait"); named(data, 11, "Caf\u0065\u0301 noir");
            named(data, 12, "星空物語"); named(data, 13, "𠮷野家"); named(data, 14, "A");
            data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            for (String text : List.of("lait cafe\u0301", "  lait\u00a0café  "))
                assertEquals(List.of(PublicNameProjection.nameUnit(id(10), "resource").getURI()), nameKeys(data, text, "keywords"));
            assertEquals(List.of(PublicNameProjection.nameUnit(id(11), "resource").getURI()), nameKeys(data, "noir café", "keywords"));
            for (String text : List.of("星空物語", "星 空 物 語", "物語 星空", "星"))
                assertEquals(List.of(PublicNameProjection.nameUnit(id(12), "resource").getURI()), nameKeys(data, text, "keywords"));
            assertEquals(List.of(PublicNameProjection.nameUnit(id(13), "resource").getURI()), nameKeys(data, "𠮷", "keywords"));
            assertEquals(List.of(PublicNameProjection.nameUnit(id(14), "resource").getURI()), nameKeys(data, "a", "keywords"));
            assertTrue(nameKeys(data, "猫", "keywords").isEmpty());
            assertFalse(names(data, "𠮷".repeat(80), "keywords").get("more").getAsBoolean().value());
            assertThrows(TextIndexException.class, () -> index.ranked(p("publicTitle"), "𠮷".repeat(81), 1, null, data,
                new FilteredGraphTextIndex.RankScope(null, null, null, false, "resource", null)));
            assertThrows(TextIndexException.class, () -> index.ranked(p("publicTitle"), "\u0344".repeat(41), 1, null, data,
                new FilteredGraphTextIndex.RankScope(null, null, null, false, "resource", null)));
        } finally { data.end(); data.close(); }
    }
    @Test public void keywordHitsStillRequireTheCurrentPublicUnwithdrawnOwner() {
        var index = index(); var data = dataset(index); data.begin(ReadWrite.WRITE);
        try { work(data, id(1), id(2)); named(data, 10, "The Winter Garden"); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.READ);
        try { assertEquals(1, nameKeys(data, "garden winter", "keywords").size()); }
        finally { data.end(); }
        // Keep the stored projection deliberately stale; ranked disclosure must use current facts.
        data.begin(ReadWrite.WRITE);
        try { set(data, CURRENT, id(10), "disclosure", p("Private")); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            assertTrue(nameKeys(data, "garden winter", "keywords").isEmpty());
            assertEquals(1, names(data, "garden winter", "keywords").get("hits").getAsArray().size());
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            set(data, CURRENT, id(10), "disclosure", null);
            set(data, CURRENT, id(10), "semanticHead", id(99)); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try { assertTrue(nameKeys(data, "garden winter", "keywords").isEmpty()); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            Node head = uri(id(10).getURI() + "/revision");
            set(data, CURRENT, id(10), "semanticHead", head);
            data.add(REVISIONS, head, RDF.type.asNode(), p("ErasedRevision")); data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try { assertTrue(nameKeys(data, "garden winter", "keywords").isEmpty()); }
        finally { data.end(); data.close(); }
    }

    @Test public void keywordAliasPagesAdvanceEveryPhysicalHitAndFinishWithoutDuplicateResources() {
        var index = index(); var data = dataset(index); data.begin(ReadWrite.WRITE);
        try {
            work(data, id(1), id(2));
            for (int n = 10; n < 80; n++) named(data, n, "The Winter Garden", "Winter and Garden");
            data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try {
            var scope = new FilteredGraphTextIndex.RankScope(null, null, null, false, "resource", null, "keywords");
            var seen = new java.util.HashSet<String>();
            FilteredGraphTextIndex.RankAfter after = null;
            boolean complete = false;
            for (int n = 0; n < 20; n++) {
                var page = index.ranked(p("publicTitle"), "garden winter", 17, after, data, scope);
                assertTrue(page.hits().size() <= 17);
                for (var hit : page.hits()) if (hit.key() != null) assertTrue("Duplicate resource", seen.add(hit.key()));
                if (!page.more()) { complete = true; break; }
                assertFalse(page.hits().isEmpty());
                var last = page.hits().getLast();
                assertNotNull(last.document());
                after = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), page.commit(), last.document());
            }
            assertTrue("Traversal must terminate", complete); assertEquals(70, seen.size());
            var invalid = new FilteredGraphTextIndex.RankScope(null, null, null, false, "resource", null, "fuzzy");
            assertThrows(TextIndexException.class, () -> index.ranked(p("publicTitle"), "garden winter", 17, null, data, invalid));
        } finally { data.end(); data.close(); }
    }

}

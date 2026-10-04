package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class ChapterPostMigrationPolicyTest {
    private static final String RV = "https://rezics.com/vocab/", SCHEMA = "https://schema.org/";
    private static final String POST = "urn:probe:post", MAIN = "urn:probe:main", BOOK = "urn:probe:book";
    private static final String HEAD = "urn:probe:head", PLACE = "urn:probe:placement", GENERATION = "urn:probe:generation";
    private static final String RECEIPT = "urn:rezics:receipt:chapter-post-backfill:" + "a".repeat(64);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static void add(DatasetGraph data, String graph, String subject, String predicate, String object) {
        data.add(uri(graph), uri(subject), uri(predicate), uri(object));
    }
    private static ModelMutationPolicy.Snapshot before() {
        var post = new ModelMutationPolicy.Subject(uri(CommandPolicy.CURRENT), null, Map.of(),
            Set.of(uri(SCHEMA + "CreativeWork")), Map.of("postMain", Set.of(uri(MAIN)),
                "postHead", Set.of(uri(HEAD)), "postBook", Set.of(uri(BOOK))));
        var main = new ModelMutationPolicy.Subject(uri(CommandPolicy.CURRENT), null, Map.of(),
            Set.of(uri(RV + "MainVersion")), Map.of("chapterOwner", Set.of(uri(POST)),
                "hostingPolicy", Set.of(uri(RV + "MetadataOnly"))));
        return new ModelMutationPolicy.Snapshot(Map.of(POST, post, MAIN, main), Map.of());
    }
    private static DatasetGraph converted() {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        add(data, CommandPolicy.CURRENT, POST, RDF.type.getURI(), RV + "Post");
        add(data, CommandPolicy.CURRENT, POST, RV + "head", HEAD);
        add(data, CommandPolicy.CURRENT, POST, RV + "publisher", "urn:probe:author");
        add(data, CommandPolicy.CURRENT, BOOK, RDF.type.getURI(), SCHEMA + "Book");
        add(data, CommandPolicy.CURRENT, BOOK, RV + "mainVersion", "urn:probe:book-main");
        add(data, CommandPolicy.CURRENT, PLACE, SCHEMA + "item", POST);
        add(data, CommandPolicy.CURRENT, PLACE, RV + "occurrenceRole", RV + "ChapterRole");
        add(data, CommandPolicy.CURRENT, PLACE, RV + "generation", GENERATION);
        add(data, CommandPolicy.CURRENT, GENERATION, RV + "generationState", RV + "Active");
        add(data, CommandPolicy.CURRENT, "urn:probe:structure", RV + "selectedGeneration", GENERATION);
        add(data, CommandPolicy.CURRENT, "urn:probe:structure", RV + "structureProfile", RV + "BookComposition");
        add(data, CommandPolicy.CURRENT, "urn:probe:structure", RV + "structureOf", "urn:probe:book-main");
        add(data, CommandPolicy.RECEIPTS, RECEIPT, RV + "outcome", RV + "Succeeded");
        add(data, CommandPolicy.RECEIPTS, RECEIPT, RV + "migratedPost", POST);
        data.add(uri(CommandPolicy.RECEIPTS), uri(RECEIPT), uri(RV + "action"), NodeFactory.createLiteralString("post.migrate"));
        data.add(uri(CommandPolicy.RECEIPTS), uri(RECEIPT), uri(RV + "migratedPostCount"), NodeFactory.createLiteralString("1"));
        return data;
    }

    @Test public void onlyExactLegacyChapterAndItsFullyRemovedMainCanRetire() {
        DatasetGraph data = converted();
        try {
            assertEquals(Set.of(POST, MAIN), ChapterPostMigrationPolicy.retired(data, RECEIPT, before()));
            assertTrue(ChapterPostMigrationPolicy.retired(data, "urn:rezics:receipt:ordinary", before()).isEmpty());
            add(data, CommandPolicy.CURRENT, MAIN, RV + "head", HEAD);
            assertTrue(ChapterPostMigrationPolicy.retired(data, RECEIPT, before()).isEmpty());
            data.delete(uri(CommandPolicy.CURRENT), uri(MAIN), uri(RV + "head"), uri(HEAD));
            add(data, CommandPolicy.CURRENT, PLACE, RV + "removedBy", "urn:probe:removal");
            assertTrue(ChapterPostMigrationPolicy.retired(data, RECEIPT, before()).isEmpty());
            data.delete(uri(CommandPolicy.CURRENT), uri(PLACE), uri(RV + "removedBy"), uri("urn:probe:removal"));
            data.delete(uri(CommandPolicy.CURRENT), uri(POST), uri(RV + "head"), uri(HEAD));
            add(data, CommandPolicy.CURRENT, POST, RV + "head", "urn:probe:changed-head");
            assertTrue(ChapterPostMigrationPolicy.retired(data, RECEIPT, before()).isEmpty());
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void independentWorksAndUnrelatedOrHistoricalMutationsCannotUseTheConversion() {
        DatasetGraph data = converted();
        try {
            var current = new HashMap<>(before().current());
            var post = current.get(POST);
            current.put(POST, new ModelMutationPolicy.Subject(post.graph(), null, Map.of(),
                Set.of(uri(SCHEMA + "CreativeWork"), uri(SCHEMA + "Book")), post.mutationBasis()));
            assertTrue(ChapterPostMigrationPolicy.retired(data, RECEIPT,
                new ModelMutationPolicy.Snapshot(current, Map.of())).isEmpty());
            current = new HashMap<>(before().current());
            current.put("urn:probe:unrelated", post);
            assertTrue(ChapterPostMigrationPolicy.retired(data, RECEIPT,
                new ModelMutationPolicy.Snapshot(current, Map.of())).isEmpty());
            assertTrue(ChapterPostMigrationPolicy.retired(data, RECEIPT,
                new ModelMutationPolicy.Snapshot(before().current(), Map.of(HEAD, post))).isEmpty());
        } finally { data.abort(); data.end(); data.close(); }
    }
}

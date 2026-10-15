package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.*;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.Entity;
import org.apache.lucene.index.Term;
import org.junit.Test;

public class CachedTitleRankTest {
    private static Node p(String name) { return NodeFactory.createURI("https://rezics.com/vocab/" + name); }
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final String PHRASE = "Cachedgarden lanterns";

    @Test public void cachedTitleTiesHaveBoundedNativeWorkAtThreeScales() throws Exception {
        try (var f = new RealmSearchSeekTest.Fixture()) {
            int population = 0;
            long baseline = 0;
            var failures = new ArrayList<String>();
            for (int size : new int[] {10, 100, 1000}) {
                if (!f.data.isInTransaction()) f.data.begin(ReadWrite.WRITE);
                while (population < size) {
                    var owner = f.owner(40000 + population++ * 10, false, false, "Unrelated article", null);
                    f.data.add(PUBLIC, owner.unit(), p("publicTitle"), NodeFactory.createLiteralLang(PHRASE, "en"));
                    f.index.refreshRankSubject(f.data, owner.unit().getURI());
                }
                f.committed();
                f.data.begin(ReadWrite.READ);
                try (var work = new CommandWork()) {
                    var page = f.index.ranked(p("searchBody"), PHRASE, 1, null, f.data,
                        new FilteredGraphTextIndex.RankScope(null, null, null, true));
                    assertEquals(1, page.hits().size()); assertTrue(page.more());
                    assertNotNull(page.hits().getFirst().key());
                    assertEquals(1_000_000f, page.hits().getFirst().score(), 0f);
                    long moves = CommandWork.currentCount("rank_lucene_iterator_next_calls")
                        + CommandWork.currentCount("rank_lucene_iterator_advance_calls")
                        + CommandWork.currentCount("rank_lucene_two_phase_matches");
                    System.out.printf("cached titles size=%d moves=%d%n", size, moves);
                    assertTrue(moves > 0);
                    if (size == 10) baseline = moves;
                    if (moves > baseline + 128) failures.add("size=" + size + " moves=" + moves + " baseline=" + baseline);
                } finally { f.data.end(); }
            }
            assertTrue(failures.toString(), failures.isEmpty());
        }
    }

    @Test public void legacyTitleDocumentsUseTheExistingStartupRebuild() throws Exception {
        try (var f = new RealmSearchSeekTest.Fixture()) {
            var owner = f.owner(60000, false, false, "Unrelated article", null);
            f.data.add(PUBLIC, owner.unit(), p("publicTitle"), NodeFactory.createLiteralLang(PHRASE, "en"));
            f.committed();
            var writer = f.index.lucene().getIndexWriter();
            writer.deleteDocuments(new Term("uri", owner.unit().getURI()));
            var legacy = new Entity(owner.unit().getURI(), CommandPolicy.PUBLIC_SEARCH, "en", null);
            legacy.put("publicTitle", PHRASE);
            f.index.lucene().addEntity(legacy); f.index.lucene().commit();
            assertTrue(f.index.rankMetadataMissing());
            assertTrue(OccurrenceTextSchema.rebuildIfIncompatible(f.data));
            assertFalse(f.index.rankMetadataMissing());
            f.data.begin(ReadWrite.READ);
            try {
                var page = f.index.ranked(p("searchBody"), PHRASE, 1, null, f.data,
                    new FilteredGraphTextIndex.RankScope(null, null, null, true));
                assertEquals(owner.main().getURI(), page.hits().getFirst().key());
                assertEquals(1_000_000f, page.hits().getFirst().score(), 0f);
            } finally { f.data.end(); }
        }
    }
}

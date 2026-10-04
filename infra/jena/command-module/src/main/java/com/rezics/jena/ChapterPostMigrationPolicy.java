package com.rezics.jena;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** The bounded legacy conversion preserves resource/head identity and history.
 * Only its removed MetadataOnly Main and the retyped chapter bypass prestate
 * shapes: those shapes describe the old Work identity, not the new Post. */
final class ChapterPostMigrationPolicy {
    private static final String RV = "https://rezics.com/vocab/", SCHEMA = "https://schema.org/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Set<Node> values(DatasetGraph data, Node graph, Node subject, String predicate) {
        Set<Node> result = new HashSet<>();
        data.find(graph, subject, uri(predicate), Node.ANY).forEachRemaining(quad -> result.add(quad.getObject()));
        return Set.copyOf(result);
    }
    private static Node single(Map<String, Set<Node>> basis, String key) {
        Set<Node> values = basis.getOrDefault(key, Set.of());
        return values.size() == 1 && values.iterator().next().isURI() ? values.iterator().next() : null;
    }

    static Set<String> retired(DatasetGraph data, String receipt, ModelMutationPolicy.Snapshot before) {
        if (!receipt.matches("urn:rezics:receipt:chapter-post-backfill:[0-9a-f]{64}")
            || !before.revisions().isEmpty()) return Set.of();
        Node own = uri(receipt);
        if (!data.contains(RECEIPTS, own, uri(RV + "action"), NodeFactory.createLiteralString("post.migrate"))
            || !data.contains(RECEIPTS, own, uri(RV + "outcome"), uri(RV + "Succeeded"))) return Set.of();
        Set<Node> posts = values(data, RECEIPTS, own, RV + "migratedPost");
        Set<Node> count = values(data, RECEIPTS, own, RV + "migratedPostCount");
        if (posts.isEmpty() || posts.size() > 24 || count.size() != 1
            || !count.iterator().next().isLiteral()
            || !count.iterator().next().getLiteralLexicalForm().equals(Integer.toString(posts.size()))) return Set.of();
        Set<String> retired = new HashSet<>();
        for (Node post : posts) {
            if (!post.isURI()) return Set.of();
            var prior = before.current().get(post.getURI());
            if (prior == null || !prior.types().equals(Set.of(uri(SCHEMA + "CreativeWork")))) return Set.of();
            Node main = single(prior.mutationBasis(), "postMain"), head = single(prior.mutationBasis(), "postHead");
            Node book = single(prior.mutationBasis(), "postBook");
            if (main == null || head == null || book == null) return Set.of();
            var oldMain = before.current().get(main.getURI());
            if (oldMain == null || !oldMain.types().equals(Set.of(uri(RV + "MainVersion")))
                || !oldMain.mutationBasis().getOrDefault("chapterOwner", Set.of()).equals(Set.of(post))
                || !oldMain.mutationBasis().getOrDefault("hostingPolicy", Set.of()).equals(Set.of(uri(RV + "MetadataOnly")))
                || data.find(CURRENT, main, Node.ANY, Node.ANY).hasNext()
                || !values(data, CURRENT, post, RDF.type.getURI()).equals(Set.of(uri(RV + "Post")))
                || !values(data, CURRENT, post, RV + "head").equals(Set.of(head))
                || !values(data, CURRENT, post, RV + "mainVersion").isEmpty()
                || !values(data, CURRENT, post, SCHEMA + "isPartOf").isEmpty()
                || values(data, CURRENT, post, RV + "publisher").size() != 1
                || !placed(data, post, book)) return Set.of();
            retired.add(post.getURI());
            retired.add(main.getURI());
        }
        // No unrelated current or historical component can ride this migration.
        return retired.equals(before.current().keySet()) ? Set.copyOf(retired) : Set.of();
    }

    private static boolean placed(DatasetGraph data, Node post, Node book) {
        if (!data.contains(CURRENT, book, RDF.type.asNode(), uri(SCHEMA + "Book"))) return false;
        Set<Node> mains = values(data, CURRENT, book, RV + "mainVersion");
        if (mains.size() != 1) return false;
        var placements = data.find(CURRENT, Node.ANY, uri(SCHEMA + "item"), post);
        int seen = 0;
        try {
            while (placements.hasNext()) {
                if (++seen > 256) return false;
                Node placement = placements.next().getSubject();
                if (!data.contains(CURRENT, placement, uri(RV + "occurrenceRole"), uri(RV + "ChapterRole"))
                    || data.find(CURRENT, placement, uri(RV + "removedBy"), Node.ANY).hasNext()) continue;
                Set<Node> generations = values(data, CURRENT, placement, RV + "generation");
                for (Node generation : generations) {
                    if (!data.contains(CURRENT, generation, uri(RV + "generationState"), uri(RV + "Active"))) continue;
                    var structures = data.find(CURRENT, Node.ANY, uri(RV + "selectedGeneration"), generation);
                    try {
                        while (structures.hasNext()) {
                            Node structure = structures.next().getSubject();
                            if (data.contains(CURRENT, structure, uri(RV + "structureProfile"), uri(RV + "BookComposition"))
                                && data.contains(CURRENT, structure, uri(RV + "structureOf"), mains.iterator().next())) return true;
                        }
                    } finally { org.apache.jena.atlas.iterator.Iter.close(structures); }
                }
            }
        } finally { org.apache.jena.atlas.iterator.Iter.close(placements); }
        return false;
    }

    private ChapterPostMigrationPolicy() {}
}

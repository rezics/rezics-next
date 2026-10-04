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
                || !data.contains(CURRENT, book, RDF.type.asNode(), uri(SCHEMA + "Book"))) return Set.of();
            retired.add(post.getURI());
            retired.add(main.getURI());
        }
        // No unrelated current or historical component can ride this migration.
        return retired.equals(before.current().keySet()) ? Set.copyOf(retired) : Set.of();
    }

    private ChapterPostMigrationPolicy() {}
}

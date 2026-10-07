package com.rezics.jena;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.apache.jena.graph.Node;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.RezicsLuceneDocument;
import org.apache.jena.query.text.TextIndexException;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.StringField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;

/** Bounded scalar external documents in Jena's existing writer. Callers own
 * admission, serialization, transaction/rollback and recovery fencing. Exact
 * stored-source equality is delivery evidence, never publication/read authority.
 * No RDF mutation, commit, activation or owner-custody lookup lives here.
 * The existing rank builder decorates the one Content body delivery; multivalue
 * occurrence builders retain their own admission and completeness.
 * Source references/pins travel as stored metadata, never searchable text. */
final class TextEntityDocuments {
    static final int MAX_ROWS = 64, MAX_CHARACTERS = 65_536, MAX_VALUE_BYTES = 196_608;
    // Framed leaf input bytes; command JSON admission remains an outer bound.
    static final int MAX_BATCH_BYTES = 2_000_000;
    private static final String FIELD = "externalTextField", KEY = "externalTextKey";
    private static final String SOURCE = "externalTextSource", DIGEST = "externalTextDigest";
    private static final String SCHEMA = "externalTextSchema", VERSION = "scalar-v1";

    record Scope(String unit, String graph, String field) {
        Scope {
            iri(unit); iri(graph);
            if (field == null) throw new IllegalArgumentException("external text field is missing");
            boolean privateField = "privateBody".equals(field);
            if (privateField ? !CommandPolicy.PRIVATE_SEARCH.equals(graph)
                : !CommandPolicy.PUBLIC_SEARCH.equals(graph)
                    || !List.of("label", "body", "publicTitle").contains(field))
                throw new IllegalArgumentException("external text field/graph differs");
        }
    }

    /** Opaque exact source pins supplied by an admitted owner operation. The
     * source digest identifies original custody, not the extracted text digest.
     * Epoch and head are local to that source; no site-wide head is inferred. */
    record Source(String reference, String digest, String head, String epoch, String recipe) {
        Source {
            iri(reference); iri(head); bounded(epoch, 128); bounded(recipe, 128);
            if (digest == null || !digest.matches("[0-9a-f]{64}"))
                throw new IllegalArgumentException("external source digest is invalid");
        }
        String encoded() { return frame(reference, digest, head, epoch, recipe); }
    }

    record Row(Node literal, Source source) {
        Row {
            if (source == null)
                throw new IllegalArgumentException("external text requires a literal and source");
            validateLiteral(literal);
        }
    }

    private static void validateLiteral(Node literal) {
        if (literal == null || !literal.isLiteral())
            throw new IllegalArgumentException("external text requires a literal");
        String value = literal.getLiteralLexicalForm();
        if (value.length() > MAX_CHARACTERS || bytes(value) > MAX_VALUE_BYTES)
            throw new IllegalArgumentException("external text exceeds its value bound");
        String language = literal.getLiteralLanguage();
        if (language.length() > 100 || bytes(language) > 100
            || !language.isEmpty() && !language.matches("[A-Za-z]+(?:-[A-Za-z0-9]+)*"))
            throw new IllegalArgumentException("external language is invalid");
        iri(literal.getLiteralDatatypeURI());
        if (language.isEmpty() == org.apache.jena.vocabulary.RDF.langString.getURI().equals(literal.getLiteralDatatypeURI()))
            throw new IllegalArgumentException("external literal language/datatype differs");
    }

    /** Existing scalar-v1 row identity, bounded before framing or hashing. */
    static String bodyIdentity(Scope scope, Node literal) {
        validateLiteral(literal);
        return hash(frame(scope.unit(), scope.graph(), scope.field(), frame(literal.getLiteralLexicalForm(),
            literal.getLiteralLanguage(), literal.getLiteralDatatypeURI())));
    }

    private record Prepared(String key, Document document) {}

    /** Replaces this leaf's complete bounded graph/unit/field scope only.
     * Larger name inventories need source-bound paged row-key operations in
     * the owner integration; MAX_ROWS is a turn bound, not a product name cap.
     * Legacy Jena/rank/occurrence documents are deliberately outside this scope. */
    static void replace(TextIndexLucene index, Scope scope, List<Row> rows) {
        replacePrepared(index, scope, prepare(index, scope, rows));
    }

    static void replaceRankedBody(TextIndexLucene index, Scope scope, List<Row> rows, String context, String group) {
        replacePrepared(index, scope, rankedBody(index, scope, rows, context, group));
    }

    private static void replacePrepared(TextIndexLucene index, Scope scope, List<Prepared> prepared) {
        try {
            index.getIndexWriter().deleteDocuments(query(index, scope));
            if (!prepared.isEmpty()) index.getIndexWriter().addDocuments(
                prepared.stream().map(Prepared::document).toList());
        } catch (IOException error) {
            // The enclosing transaction must roll back; never acknowledge a
            // successful graph write from a partial document replacement.
            throw new TextIndexException("external text replacement failed", error);
        }
    }

    /** Checks exactly this scope in a committed reader (never NRT). Returns
     * only its observed physical commit generation. The caller must fence any
     * intervening writer and bind journal/source/recovery coverage separately. */
    static long verifyCommitted(TextIndexLucene index, Scope scope, List<Row> expected) {
        return verifyPrepared(index, scope, prepare(index, scope, expected), false);
    }

    static long verifyCommittedRankedBody(TextIndexLucene index, Scope scope, List<Row> expected, String context, String group) {
        return verifyPrepared(index, scope, rankedBody(index, scope, expected, context, group), true);
    }

    /** The original admitted receipt supplies identity; stored text cannot mint it. */
    static long verifyCommittedRankedIdentity(TextIndexLucene index, Scope scope, String identity, Source source,
                                              String language, String context, String group) {
        if (identity == null || !identity.matches("[0-9a-f]{64}"))
            throw new TextIndexException("original body identity unavailable");
        try (DirectoryReader reader = DirectoryReader.open(index.getDirectory())) {
            var searcher = new IndexSearcher(reader);
            var hits = searcher.search(query(index, scope), 2);
            if (hits.totalHits.value() != 1) throw new TextIndexException("committed body identity membership differs");
            Document stored = searcher.storedFields().document(hits.scoreDocs[0].doc);
            String[] values = stored.getValues(scope.field()), languages = stored.getValues("lang");
            if (values.length != 1 || values[0].length() > MAX_CHARACTERS || bytes(values[0]) > MAX_VALUE_BYTES
                || languages.length > 1) throw new TextIndexException("committed body literal differs");
            String auxiliary = languages.length == 0 ? "" : languages[0];
            Node literal;
            if (auxiliary.startsWith("^^")) {
                if (auxiliary.length() > 514) throw new TextIndexException("committed body datatype exceeds bound");
                String datatype = auxiliary.substring(2); iri(datatype);
                literal = org.apache.jena.graph.NodeFactory.createLiteralDT(values[0],
                    org.apache.jena.datatypes.TypeMapper.getInstance().getSafeTypeByName(datatype));
            } else {
                if (auxiliary.length() > 100) throw new TextIndexException("committed body language exceeds bound");
                literal = auxiliary.isEmpty() ? org.apache.jena.graph.NodeFactory.createLiteralString(values[0])
                    : org.apache.jena.graph.NodeFactory.createLiteralLang(values[0], auxiliary);
            }
            if (!identity.equals(bodyIdentity(scope, literal)) || !literal.getLiteralLanguage().equalsIgnoreCase(language))
                throw new TextIndexException("committed body differs from original identity");
            long generation = verifyCommittedRankedBody(index, scope, List.of(new Row(literal, source)), context, group);
            if (generation != reader.getIndexCommit().getGeneration()) throw new TextIndexException("committed body reader changed");
            return generation;
        } catch (IOException | IllegalArgumentException error) {
            throw new TextIndexException("committed body identity inspection failed", error);
        }
    }

    private static List<Prepared> rankedBody(TextIndexLucene index, Scope scope, List<Row> rows, String context, String group) {
        if (!"body".equals(scope.field()) || !CommandPolicy.PUBLIC_SEARCH.equals(scope.graph()) || rows.size() > 1)
            throw new IllegalArgumentException("ranked Content requires one public body");
        var prepared = prepare(index, scope, rows);
        for (var row : prepared) FilteredGraphTextIndex.decorateRankDocument(row.document(), context, group);
        return prepared;
    }

    private static long verifyPrepared(TextIndexLucene index, Scope scope, List<Prepared> prepared, boolean ranked) {
        Map<String, Document> remaining = new HashMap<>();
        for (Prepared row : prepared) remaining.put(row.key(), row.document());
        try (DirectoryReader reader = DirectoryReader.open(index.getDirectory())) {
            IndexSearcher searcher = new IndexSearcher(reader);
            var hits = searcher.search(query(index, scope), MAX_ROWS + 1);
            if (hits.totalHits.value() != remaining.size() || hits.scoreDocs.length != remaining.size())
                throw new TextIndexException("external committed text membership differs");
            for (String field : index.getDocDef().fields()) if (!field.equals(scope.field())) {
                var extra = new BooleanQuery.Builder().add(query(index, scope), BooleanClause.Occur.FILTER)
                    .add(new org.apache.lucene.search.FieldExistsQuery(field), BooleanClause.Occur.FILTER).build();
                if (searcher.search(extra, 1).scoreDocs.length != 0)
                    throw new TextIndexException("external committed text has another mapped field");
            }
            if (ranked) {
                var missingRank = new BooleanQuery.Builder().add(query(index, scope), BooleanClause.Occur.FILTER)
                    .add(new TermQuery(new Term(FilteredGraphTextIndex.RANK_SCHEMA, "1")), BooleanClause.Occur.MUST_NOT).build();
                if (searcher.search(missingRank, 1).scoreDocs.length != 0)
                    throw new TextIndexException("external committed rank schema differs");
            }
            var stored = searcher.storedFields();
            for (var hit : hits.scoreDocs) {
                Document actual = stored.document(hit.doc);
                Document wanted = remaining.remove(actual.get(KEY));
                if (wanted == null) throw new TextIndexException("external committed text identity differs");
                var wantedNames = new java.util.HashSet<String>();
                for (var field : wanted.getFields()) if (field.fieldType().stored()) wantedNames.add(field.name());
                var actualNames = new java.util.HashSet<String>();
                for (var field : actual.getFields()) actualNames.add(field.name());
                if (!wantedNames.equals(actualNames))
                    throw new TextIndexException("external committed text stored fields differ");
                for (String name : wantedNames) {
                    if (!java.util.Arrays.equals(wanted.getValues(name), actual.getValues(name)))
                        throw new TextIndexException("external committed text value/source differs");
                }
            }
            if (!remaining.isEmpty()) throw new TextIndexException("external committed text is incomplete");
            return reader.getIndexCommit().getGeneration();
        } catch (IOException error) {
            throw new TextIndexException("external committed text inspection failed", error);
        }
    }

    private static List<Prepared> prepare(TextIndexLucene index, Scope scope, List<Row> input) {
        if (index == null || scope == null || input == null || input.size() > MAX_ROWS)
            throw new IllegalArgumentException("external text batch exceeds its row bound");
        var definition = index.getDocDef();
        if (!definition.fields().contains(scope.field()) || definition.getGraphField() == null
            || definition.getLangField() == null || definition.getUidField() == null)
            throw new IllegalArgumentException("external text requires the tagged graph/uid layout");
        if (!"uri".equals(definition.getEntityField()) || !"graph".equals(definition.getGraphField())
            || !"lang".equals(definition.getLangField()) || !"uid".equals(definition.getUidField()))
            throw new IllegalArgumentException("external text requires the pinned field layout");
        for (String metadata : List.of(FIELD, KEY, SOURCE, DIGEST, SCHEMA))
            if (definition.fields().contains(metadata))
                throw new IllegalArgumentException("external text metadata collides with a mapped field");
        List<Row> rows = List.copyOf(input);
        List<Prepared> result = new ArrayList<>();
        var keys = new java.util.HashSet<String>();
        int totalBytes = bytes(frame(scope.unit(), scope.graph(), scope.field()));
        for (Row row : rows) {
            Node value = row.literal();
            String term = frame(value.getLiteralLexicalForm(), value.getLiteralLanguage(), value.getLiteralDatatypeURI());
            String key = bodyIdentity(scope, value);
            String source = row.source().encoded();
            totalBytes += bytes(frame(term, source, key));
            if (totalBytes > MAX_BATCH_BYTES)
                throw new IllegalArgumentException("external text batch exceeds its byte bound");
            if (!keys.add(key)) throw new IllegalArgumentException("duplicate external text row");
            String digest = hash(frame(VERSION, key, source));
            Entity entity = new Entity(scope.unit(), scope.graph(), value.getLiteralLanguage(), value.getLiteralDatatype());
            entity.put(scope.field(), value.getLiteralLexicalForm());
            Document document = RezicsLuceneDocument.build(index, entity);
            if (!document.getField(scope.field()).fieldType().stored()
                || document.getField(scope.field()).fieldType().indexOptions() == org.apache.lucene.index.IndexOptions.NONE)
                throw new IllegalArgumentException("external text requires searchable stored original values");
            for (var entry : Map.of(FIELD, scope.field(), KEY, key, SOURCE, source,
                DIGEST, digest, SCHEMA, VERSION).entrySet()) {
                if (entry.getKey().equals(FIELD) || entry.getKey().equals(KEY))
                    document.add(new StringField(entry.getKey(), entry.getValue(), org.apache.lucene.document.Field.Store.YES));
                else document.add(new org.apache.lucene.document.StoredField(entry.getKey(), entry.getValue()));
            }
            result.add(new Prepared(key, document));
        }
        return result;
    }

    private static BooleanQuery query(TextIndexLucene index, Scope scope) {
        return new BooleanQuery.Builder()
            .add(new TermQuery(new Term(index.getDocDef().getEntityField(), scope.unit())), BooleanClause.Occur.FILTER)
            .add(new TermQuery(new Term(index.getDocDef().getGraphField(), scope.graph())), BooleanClause.Occur.FILTER)
            .add(new TermQuery(new Term(FIELD, scope.field())), BooleanClause.Occur.FILTER).build();
    }
    private static String frame(String... values) {
        StringBuilder result = new StringBuilder();
        for (String value : values) result.append(value.length()).append(':').append(value);
        return result.toString();
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static int bytes(String value) {
        if (value == null || !StandardCharsets.UTF_8.newEncoder().canEncode(value))
            throw new IllegalArgumentException("external text is not valid Unicode");
        return value.getBytes(StandardCharsets.UTF_8).length;
    }
    private static void bounded(String value, int limit) {
        if (value == null || value.isEmpty() || bytes(value) > limit)
            throw new IllegalArgumentException("external source term exceeds its bound");
    }
    private static void iri(String value) {
        bounded(value, 512);
        if (!URI.create(value).isAbsolute()) throw new IllegalArgumentException("external source IRI is not absolute");
    }
    private TextEntityDocuments() {}
}

import java.nio.file.*;
import java.util.*;

import org.apache.jena.query.*;
import org.apache.jena.system.Txn;

/** Runs spargebra-serialized queries against Jena and compares with Jena-native syntax. */
public class JenaRoundTrip {
    public static void main(String[] args) throws Exception {
        String[] blocks = Files.readString(Path.of("evidence/2026-09-23/spargebra-queries.txt")).split("(?m)^### ");
        Path root = Files.createTempDirectory("rezics-jena-roundtrip-");
        JenaCjkProbe.Profile p = JenaCjkProbe.PROFILES.get(3);
        Dataset ds = JenaCjkProbe.open(root, p);
        JenaCjkProbe.insertDocs(ds, JenaCjkProbe.DOCS);
        int ok = 0, total = 0;
        for (String block : blocks) {
            if (block.isBlank()) continue;
            int nl = block.indexOf('\n');
            String input = block.substring(0, nl).strip();
            String generated = block.substring(nl + 1).strip();
            String nativeQuery = JenaCjkProbe.PREFIX + "SELECT ?s ?score WHERE { GRAPH <urn:g:public> { (?s ?score) text:query (s:body "
                + JenaCjkProbe.sparqlString(JenaCjkProbe.compiled(input)) + " 20001) . ?s ex:cat ex:science } } ORDER BY DESC(?score) ?s LIMIT 10";
            List<String> a = run(ds, generated), b = run(ds, nativeQuery);
            total++;
            if (a.equals(b)) ok++;
            System.out.printf("%s input=%s spargebra=%s native=%s%n", a.equals(b) ? "SAME" : "DIFF", input, a, b);
        }
        System.out.printf("spargebra-serialized vs native: %d/%d identical%n", ok, total);
        ds.close();
    }

    static List<String> run(Dataset ds, String q) {
        return Txn.calculateRead(ds, () -> {
            List<String> out = new ArrayList<>();
            try (QueryExecution qe = QueryExecutionFactory.create(q, ds)) {
                ResultSet rs = qe.execSelect();
                while (rs.hasNext()) {
                    QuerySolution s = rs.next();
                    out.add(s.getResource("s").getLocalName() + "@" + String.format("%.3f", s.getLiteral("score").getFloat()));
                }
            }
            return out;
        });
    }
}

import java.nio.file.*;
import java.util.*;

import org.apache.jena.query.*;

/** Supplement: rare vs common term cost at ~100k docs on the cjk-uni+bi-both profile. */
public class JenaScale {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("rezics-jena-scale-");
        Dataset ds = JenaCjkProbe.open(root, JenaCjkProbe.PROFILES.get(3));
        List<String[]> data = new ArrayList<>();
        for (int k = 0; k < 100000; k++) data.add(new String[]{"b" + k, "中文资料第" + k + "篇", "other"});
        for (int k = 0; k < 2000; k++) data.add(new String[]{"b" + (100000 + k), "中文资料中册第" + k + "篇", "mid"});
        for (int from = 0; from < data.size(); from += 5000)
            JenaCjkProbe.insertDocs(ds, data.subList(from, Math.min(data.size(), from + 5000)).toArray(new String[0][]));
        String P = JenaCjkProbe.PREFIX;
        Map<String, String> qs = new LinkedHashMap<>();
        qs.put("text_rare_第99篇", P + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s text:query (s:body " + JenaCjkProbe.sparqlString(JenaCjkProbe.compiled("第99篇")) + " 110001) } }");
        qs.put("text_common_中文", P + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s text:query (s:body " + JenaCjkProbe.sparqlString(JenaCjkProbe.compiled("中文")) + " 110001) } }");
        qs.put("contains_rare_第99篇", P + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s s:norm ?t FILTER(CONTAINS(?t, \"第99篇\")) } }");
        qs.put("contains_mid_中文", P + "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g:public> { ?s ex:cat ex:mid ; s:norm ?t FILTER(CONTAINS(?t, \"中文\")) } }");
        for (int round = 0; round < 2; round++)
            for (var e : qs.entrySet()) {
                long t = System.nanoTime();
                long n = JenaCjkProbe.count(ds, e.getValue());
                if (round == 1) System.out.printf("jena %-22s %6d rows %6d ms%n", e.getKey(), n, (System.nanoTime() - t) / 1_000_000);
            }
        ds.close();
    }
}

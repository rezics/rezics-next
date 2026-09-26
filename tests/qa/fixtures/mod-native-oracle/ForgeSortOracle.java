import cpw.mods.jarhandling.SecureJar;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.loading.FMLLoader;
import net.minecraftforge.fml.loading.ModSorter;
import net.minecraftforge.fml.loading.moddiscovery.ModFile;
import net.minecraftforge.fml.loading.moddiscovery.ModFileParser;
import net.minecraftforge.forgespi.Environment;

public class ForgeSortOracle {
  public static void main(String[] args) throws Exception {
    var field = FMLLoader.class.getDeclaredField("dist");
    field.setAccessible(true);
    field.set(null, Dist.valueOf(args[0]));
    var unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
    unsafeField.setAccessible(true);
    var unsafe = (sun.misc.Unsafe) unsafeField.get(null);
    var environment = (Environment) unsafe.allocateInstance(Environment.class);
    var environmentDist = Environment.class.getDeclaredField("dist");
    environmentDist.setAccessible(true);
    environmentDist.set(environment, Dist.valueOf(args[0]));
    var instance = Environment.class.getDeclaredField("INSTANCE");
    instance.setAccessible(true);
    instance.set(null, environment);
    var files = new ArrayList<ModFile>();
    for (var path : Arrays.copyOfRange(args, 1, args.length)) {
      files.add(new ModFile(SecureJar.from(Path.of(path)), null, ModFileParser::modsTomlParser, "MOD"));
    }
    try {
      var sorted = ModSorter.sort(files, new ArrayList<>());
      System.out.println("SORTED " + sorted.getMods().stream().map(mod -> mod.getModId()).toList());
      System.out.println("ERRORS " + sorted.getErrors().size());
    } catch (NullPointerException error) {
      if (error.getMessage() == null || !error.getMessage().contains("sortedList")) throw error;
      System.out.println("CYCLE_FAILURE NullPointerException sortedList");
    }
  }
}

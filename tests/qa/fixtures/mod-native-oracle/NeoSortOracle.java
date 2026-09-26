import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import net.neoforged.fml.jarcontents.JarContents;
import net.neoforged.fml.loading.moddiscovery.ModFile;
import net.neoforged.fml.loading.moddiscovery.ModFileParser;
import net.neoforged.neoforgespi.locating.IModFile;
import net.neoforged.fml.loading.FMLLoader;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.loading.VersionInfo;
import java.util.concurrent.atomic.AtomicReference;

public class NeoSortOracle {
  public static void main(String[] args) throws Exception {
    var unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
    unsafeField.setAccessible(true);
    var unsafe = (sun.misc.Unsafe) unsafeField.get(null);
    var loader = (FMLLoader) unsafe.allocateInstance(FMLLoader.class);
    var dist = FMLLoader.class.getDeclaredField("dist");
    dist.setAccessible(true);
    dist.set(loader, Dist.valueOf(args[0]));
    var current = FMLLoader.class.getDeclaredField("current");
    current.setAccessible(true);
    ((AtomicReference<FMLLoader>) current.get(null)).set(loader);
    var matrixType = Class.forName("net.neoforged.fml.loading.VersionSupportMatrix");
    var constructor = matrixType.getDeclaredConstructor(VersionInfo.class);
    constructor.setAccessible(true);
    var matrix = FMLLoader.class.getDeclaredField("versionSupportMatrix");
    matrix.setAccessible(true);
    matrix.set(loader, constructor.newInstance(new VersionInfo("10.0.34", "1.21.1", "1.21.1")));
    var files = new ArrayList<ModFile>();
    for (var path : Arrays.copyOfRange(args, 1, args.length)) {
      files.add((ModFile) IModFile.create(JarContents.ofPath(Path.of(path)),
          ModFileParser::modsTomlParser));
    }
    var sorter = Class.forName("net.neoforged.fml.loading.ModSorter");
    var sort = sorter.getDeclaredMethod("sort", java.util.List.class, java.util.List.class);
    sort.setAccessible(true);
    try {
      var sorted = (net.neoforged.fml.loading.LoadingModList) sort.invoke(null, files, new ArrayList<>());
      System.out.println("SORTED " + sorted.getMods().stream().map(mod -> mod.getModId()).toList());
      System.out.println("ERRORS " + sorted.hasErrors());
    } catch (java.lang.reflect.InvocationTargetException error) {
      if (!(error.getCause() instanceof ClassCastException)) throw error;
      System.out.println("CYCLE_FAILURE ClassCastException ModInfo");
    }
  }
}

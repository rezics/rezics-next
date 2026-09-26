import cpw.mods.jarhandling.SecureJar;
import java.nio.file.Path;
import net.minecraftforge.fml.loading.moddiscovery.ModFile;
import net.minecraftforge.fml.loading.moddiscovery.ModFileParser;
import net.minecraftforge.forgespi.locating.ForgeFeature;
import net.minecraftforge.forgespi.language.IModInfo;
import net.minecraftforge.api.distmarker.Dist;

public class ForgeOracle {
  public static void main(String[] args) throws Exception {
    var file = new ModFile(SecureJar.from(Path.of(args[0])), null,
        ModFileParser::modsTomlParser, "MOD");
    var info = file.getModFileInfo();
    System.out.println("CLIENT_SIDE_ONLY " + info.isClientSideOnly());
    for (var mod : info.getMods()) {
      System.out.println("MOD " + mod.getModId() + " " + mod.getVersion());
      for (var feature : mod.getForgeFeatures()) {
        System.out.println("FEATURE " + feature.featureName() + " " + feature.featureBound());
        ForgeFeature.registerFeature(feature.featureName(),
            ForgeFeature.VersionFeatureTest.forVersionString(IModInfo.DependencySide.CLIENT, "3.1"));
        System.out.println("FEATURE_CLIENT_3_1 " + ForgeFeature.testFeature(Dist.CLIENT, feature));
        System.out.println("FEATURE_SERVER_3_1 " + ForgeFeature.testFeature(Dist.DEDICATED_SERVER, feature));
      }
      for (var dependency : mod.getDependencies()) {
        System.out.println("DEPENDENCY " + dependency.getModId() + " "
            + dependency.getSide() + " " + dependency.getOrdering() + " "
            + dependency.isMandatory() + " " + dependency.getVersionRange());
      }
    }
  }
}

{
  description = "REZICS PKG06 input, derivation and closure fixture";
  inputs.base.url = "path:./base";
  inputs.base.flake = false;
  inputs.alias.follows = "base";
  outputs = { self, base, alias }:
    let
      buildInput = builtins.derivation {
        name = "rezics-nix-build-input";
        system = "x86_64-linux";
        builder = "/bin/sh";
        args = [ "-c" "printf 'build input\\n' > $out" ];
      };
    in {
      packages.x86_64-linux.default = builtins.derivation {
        name = "rezics-nix-result";
        system = "x86_64-linux";
        builder = "/bin/sh";
        args = [ "-c" "printf 'runtime result\\n' > $out" ];
        buildInput = buildInput.outPath;
        source = base;
        aliasSource = alias;
      };
    };
}

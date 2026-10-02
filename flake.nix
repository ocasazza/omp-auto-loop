{
  description = "omp-auto-loop — autonomous loop extension for the omp/pi coding agent, vendored";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    forAllSystems = nixpkgs.lib.genAttrs [
      "aarch64-darwin"
      "x86_64-linux"
    ];
  in {
    # A home-manager module (NOT a NixOS module: it wires launchd agents
    # and xdg.configFile). Consumers import ./nix/module.nix by path or
    # take this attrset; the module's `inputs` argument must carry
    # jump-cannon (consumers pass their flake inputs as specialArgs).
    hmModules.default = import ./nix/module.nix;

    packages = forAllSystems (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};

        # The extension as a DIRECTORY copy: reference it as
        # "${pkg}/auto-loop.ts" — jiti loads that path inside omp, and the
        # entry imports ./lib/*.ts relatively, so the directory (lib/
        # included) is the thing that must live in the store. Interpolating
        # the bare file would strand it at a store root where ./lib/ cannot
        # resolve.
        extension = pkgs.stdenv.mkDerivation {
          name = "omp-auto-loop-extension";
          src = ./extension;
          nativeBuildInputs = [pkgs.bun];
          buildPhase = ''
            # Load check the way pi/omp loads the entry through jiti:
            # transpile it and resolve the full relative module graph.
            # @oh-my-pi/omptype stays external — omp's own runtime supplies
            # it, exactly as it does at session time.
            bun build auto-loop.ts --target=bun \
              --external @oh-my-pi/omptype \
              --outfile=$TMPDIR/entry-check.js
          '';
          installPhase = ''
            mkdir -p $out
            cp -r . $out/
          '';
        };
      in {
        default = extension;
        extensionEntry = extension;
      }
    );

    checks = forAllSystems (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        # The full node:test suite (test/*.test.ts) under bun.
        tests = pkgs.stdenv.mkDerivation {
          name = "omp-auto-loop-tests";
          src = ./.;
          nativeBuildInputs = [pkgs.bun];
          buildPhase = ''
            bun test test/
          '';
          installPhase = ''
            mkdir -p $out
            touch $out/done
          '';
        };
      }
    );

    formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.alejandra);

    devShells = forAllSystems (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.alejandra
          ];
        };
      }
    );
  };
}

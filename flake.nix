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
        # The one runtime dependency the entry imports. Locally bun fetches it
        # on demand; the sandbox has no network, so it is pinned to bun.lock's
        # integrity hash.
        omptype = pkgs.fetchurl {
          url = "https://registry.npmjs.org/@oh-my-pi/omptype/-/omptype-18.4.10.tgz";
          hash = "sha512-ECtpjcs0S9ciiruXCAhUInOGR0UoMYA9n0ktkshb8JvGmZPHsxInsEYDVuqUuYLoNCk6FY1/wGx9aphjSdUfkQ==";
        };
      in {
        # The full node:test suite (test/*.test.ts) under bun. git lets the
        # gate tests attest a real worktree instead of skipping.
        tests = pkgs.stdenv.mkDerivation {
          name = "omp-auto-loop-tests";
          src = ./.;
          nativeBuildInputs = [pkgs.bun pkgs.git];
          buildPhase = ''
            export HOME=$TMPDIR
            mkdir -p node_modules/@oh-my-pi/omptype
            tar -xzf ${omptype} -C node_modules/@oh-my-pi/omptype --strip-components=1
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

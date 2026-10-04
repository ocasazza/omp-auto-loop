# The omp auto-loop plugin: option surface, the extension's store path, and
# the jump-cannon canvas deployment that renders the loop as a graph.
#
# Self-contained by design — every path is relative to THIS repository, so
# the flake can be consumed without touching the omp harness module. One
# rule that is not stylistic:
#   1. The extension is delivered as a DIRECTORY copy (exposed to the
#      harness through local.omp.autoLoop.extensionEntries as
#      "${./../extension}/auto-loop.ts"). The entry file imports
#      ./lib/*.ts relatively; interpolating a single file would place it at
#      the store root where ./lib/ cannot resolve, and the extension then
#      fails to load with no error until a session tries to continue.
{
  config,
  inputs,
  lib,
  pkgs,
  ...
}: let
  cfg = config.local.omp.autoLoop;
  canvasEnabled = cfg.jumpCannon.enable && pkgs.stdenv.hostPlatform.isDarwin;
  canvasLabel = "local.omp-auto-loop-jump-cannon";
  graphProxyLabel = "local.omp-auto-loop-graph-proxy";

  # Extension entries for the harness's PI_CONFIG_FILES settings overlay.
  # Modules cannot merge into the harness's `extensions` array directly —
  # omp's settings merge deep-merges objects but REPLACES arrays, so a
  # second overlay setting `extensions` would silently drop the harness's
  # entries. The harness appends cfg.extensionEntries under its own
  # autoLoop.enable gate instead.
  extensionEntries =
    ["${./../extension}/auto-loop.ts"]
    ++ lib.optionals cfg.impBridge.enable ["${./../extension}/imp-bridge.ts"];
in {
  options.local.omp.autoLoop = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Load the omp-auto-loop extension: a port of prime-agent's internal
        autonomous runtime (PrimeIntellect prime-agent, core/autonomous.ts
        + goals.ts + cron-jobs.ts). Always on — no slash command. Each user
        input starts a cycle with prime-agent budgets (3 continuations,
        30-minute timeout); settles keep working (questions get
        assumed-and-verified) until gates pass, the model reports
        AUTOLOOP:DONE, or a cap trips. Includes the model-driven goal tool
        and an idle heartbeat while a goal is active. Tune or kill via
        OMP_AUTO_LOOP_MAX_CONTINUATIONS, OMP_AUTO_LOOP_TIMEOUT_MS,
        OMP_AUTO_LOOP_GATES (JSON array of verifier commands — when set,
        gates are the termination authority), OMP_AUTO_LOOP_GATE_RETRIES,
        OMP_AUTO_LOOP_GATE_TIMEOUT_MS, OMP_AUTO_LOOP_HEARTBEAT_MS and
        OMP_AUTO_LOOP_DISABLE in defaultEnv.
      '';
    };

    dashboardPort = lib.mkOption {
      type = lib.types.port;
      default = 8798;
      description = ''
        Loopback port for the loop's own dashboard (review, steering,
        taxonomy). The first omp session to start serves it. Must differ
        from jumpCannon.port.
      '';
    };

    jumpCannon = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          The plugin's visualization: jump-cannon's native graph-api (flake
          input, crane-built binary) against the omp auto-loop pest package,
          watching ~/.local/state/omp-auto-loop/graph.lines — the loop as a
          live graph on the jump-cannon canvas per the OMP Auto-Loop Topos.
        '';
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 8799;
        description = "Loopback port for the jump-cannon graph-api.";
      };

      proxyPort = lib.mkOption {
        type = lib.types.port;
        default = 8765;
        description = ''
          Loopback port the canvas UI's Sessions view talks to. The port is
          compiled into the UI, so a reverse proxy forwards it to the
          graph-api port; changing this does not move the UI's target.
        '';
      };

      lifecycle = lib.mkOption {
        type = lib.types.enum [
          "omp"
          "always"
        ];
        default = "omp";
        description = ''
          When the canvas runs. "omp": the extension starts it with the first
          interactive omp session and stops it after the last one exits
          (one-shot `omp -p` runs never start it). "always": launchd keeps it
          running from login.
        '';
      };
    };

    impBridge = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Also load the imp bridge: a standalone extension (it shares
          nothing with auto-loop.ts's runtime) that lands one-line
          session_stop summaries on the imp agent board, fire-and-forget.
        '';
      };

      url = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:4010";
        description = "Base URL of the imp agent board's HTTP API.";
      };

      room = lib.mkOption {
        type = lib.types.str;
        default = "kitchen";
        description = "Board room the summaries are posted to.";
      };
    };

    extensionEntries = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      readOnly = true;
      description = ''
        Store paths of this repo's extension entries, for the omp harness's
        PI_CONFIG_FILES overlay to append to its `extensions` array under
        its autoLoop.enable gate (auto-loop.ts always; imp-bridge.ts when
        impBridge.enable). Directory copies by contract — never interpolate
        the bare entry files.
      '';
    };
  };

  config = {
    # A pure value of this repository, defined regardless of enable: the
    # gating decision belongs to the overlay that appends the entries.
    local.omp.autoLoop.extensionEntries = extensionEntries;

    # Gate on the harness too: autoLoop.enable defaults on, and without this
    # every Home Manager user on the host (logged in or not) got the canvas
    # agent, whose bootstrap into an absent gui/<uid> domain fails the
    # switch.
    xdg.configFile = lib.mkIf (config.local.omp.enable && cfg.enable) {
      # jump-cannon canvas over the loop (see launchd agent below).
      "omp-auto-loop/canvas-agent" = lib.mkIf (
        canvasEnabled && cfg.jumpCannon.lifecycle == "omp"
      ) {text = canvasLabel;};

      # Shared runtime config: the extension binds dashboardPort; `doctor`
      # health-checks the graph-api on graphApiPort; imp-bridge.ts reads the
      # impBridge block (enable must be exactly true). Emitted whenever the
      # extension is on — including lifecycle == "always", where no
      # canvas-agent file exists.
      "omp-auto-loop/config.json".text = builtins.toJSON {
        version = 1;
        dashboardPort = cfg.dashboardPort;
        graphApiPort = cfg.jumpCannon.port;
        impBridge = {
          enable = cfg.impBridge.enable;
          url = cfg.impBridge.url;
          room = cfg.impBridge.room;
        };
      };
    };

    # jump-cannon canvas over the loop: the native graph-api binary from the
    # jump-cannon flake input, bound to the omp-auto-loop pest package and
    # the extension's graph.lines projection. The file watcher re-imports on
    # every write; no periodic rescan, since each rescan publishes a new graph
    # revision even for an unchanged file and the canvas re-lays out on it.
    # The UI is app-web (served from /), not app-web-pages, whose GitHub
    # Pages build references its assets under /jump-cannon/ and 404s here.
    launchd.agents.omp-auto-loop-jump-cannon = lib.mkIf (canvasEnabled && config.local.omp.enable && cfg.enable) {
      enable = true;
      config = {
        Label = canvasLabel;
        ProgramArguments = [
          "${inputs.jump-cannon.packages.${pkgs.stdenv.hostPlatform.system}.graph-api}/bin/graph-api"
          "--source=pest"
          "--importer-manifest=${inputs.jump-cannon}/charts/jump-cannon/packages/omp-auto-loop.toml"
          "--importer-input=${config.home.homeDirectory}/.local/state/omp-auto-loop/graph.lines"
          # Content scope for node bodies: graph-api serves a body only
          # when the importer may read the filesystem under the vault root,
          # which otherwise defaults to the agent's cwd (/) and yields
          # "metadata only" in the Nodes panel.
          "--vault-root=${config.home.homeDirectory}/.local/state/omp-auto-loop"
          "--port=${toString cfg.jumpCannon.port}"
          "--assets-dir=${inputs.jump-cannon.packages.${pkgs.stdenv.hostPlatform.system}.app-web}"
        ];
        EnvironmentVariables = {
          GRAPH_API_NO_BROWSER = "true";
          RUST_LOG = "info";
        };
        # Under "omp" the agent is loaded but idle until an omp session
        # kickstarts it, and a stop stays stopped.
        RunAtLoad = cfg.jumpCannon.lifecycle == "always";
        KeepAlive = cfg.jumpCannon.lifecycle == "always";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/omp-auto-loop-jump-cannon.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/omp-auto-loop-jump-cannon.log";
      };
    };

    # The canvas UI's Sessions view is compiled against :8765, while the
    # graph-api that answers it runs on the jump-cannon port. Forwarding
    # rather than reimplementing keeps the upstream contract the real one:
    # without this the tab calls /graph/init, /graph/ids and /progress on a
    # port nothing listens on and logs ERR_CONNECTION_REFUSED forever.
    launchd.agents.omp-auto-loop-graph-proxy = lib.mkIf (canvasEnabled && config.local.omp.enable && cfg.enable) {
      enable = true;
      config = {
        Label = graphProxyLabel;
        ProgramArguments = [
          "${pkgs.bun}/bin/bun"
          "run"
          "${./graph-proxy.mjs}"
        ];
        EnvironmentVariables = {
          OMP_GRAPH_PROXY_PORT = toString cfg.jumpCannon.proxyPort;
          OMP_GRAPH_UPSTREAM_PORT = toString cfg.jumpCannon.port;
        };
        RunAtLoad = true;
        KeepAlive = true;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/omp-auto-loop-graph-proxy.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/omp-auto-loop-graph-proxy.log";
      };
    };
  };
}

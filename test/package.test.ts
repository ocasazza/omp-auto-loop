// AC-4 smoke: the deployed shape must resolve its own relative imports.
//
// This is the trap that shipped once: interpolating a single FILE put the
// entry at the store root, where `./lib/core.ts` cannot resolve, and the
// extension failed to load with no error until a session tried to continue.
// The test walks the same resolution the runtime does, plus the module and
// flake wiring that puts the entry on omp's extension list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(HERE, "../extension/auto-loop.ts");
const LIB = resolve(HERE, "../extension/lib");
const MODULE = resolve(HERE, "../nix/module.nix");
const FLAKE = resolve(HERE, "../flake.nix");

test("the entry file exists next to its lib/ directory", () => {
  assert.ok(existsSync(EXTENSION), "extension/auto-loop.ts is part of the plugin");
  assert.ok(existsSync(join(LIB, "core.ts")), "lib/core.ts sits beside it, not at a store root");
});

test("every relative import in the entry resolves to a real file", () => {
  const source = readFileSync(EXTENSION, "utf8");
  const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(specifiers.length >= 4, `expected the entry to import its lib modules, saw ${specifiers.length}`);
  for (const spec of specifiers) {
    assert.ok(existsSync(resolve(dirname(EXTENSION), spec)), `relative import must resolve: ${spec}`);
  }
});

test("the module registers the extension as a directory copy", () => {
  // A single-file interpolation would put the entry at a store root where
  // ./lib/ cannot resolve.
  const moduleSrc = readFileSync(MODULE, "utf8");
  assert.match(
    moduleSrc,
    /\$\{\.\/\.\.\/extension\}\/auto-loop\.ts/,
    "delivered as a directory copy",
  );
  assert.doesNotMatch(
    moduleSrc,
    /\$\{\.\/\.\.\/extension\/auto-loop\.ts\}/,
    "never a bare single-file interpolation",
  );
});

test("the imp bridge entry is registered the same way", () => {
  const moduleSrc = readFileSync(MODULE, "utf8");
  assert.match(
    moduleSrc,
    /\$\{\.\/\.\.\/extension\}\/imp-bridge\.ts/,
    "delivered as a directory copy",
  );
  assert.doesNotMatch(
    moduleSrc,
    /\$\{\.\/\.\.\/extension\/imp-bridge\.ts\}/,
    "never a bare single-file interpolation",
  );
});

test("every path the plugin module interpolates exists", () => {
  // A deleted file left referenced breaks evaluation of the whole host config.
  const moduleSrc = readFileSync(MODULE, "utf8");
  const code = moduleSrc.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  for (const [, ref] of code.matchAll(/\$\{\.\/([^}]+)\}/g)) {
    // Paths in nix/module.nix are relative to nix/.
    assert.ok(existsSync(resolve(HERE, "..", "nix", ref!)), `module references a missing path: ./${ref}`);
  }
});

test("the flake wires the test suite into nix flake check", () => {
  assert.ok(existsSync(FLAKE), "flake.nix is the repository's build entry");
  const flakeSrc = readFileSync(FLAKE, "utf8");
  assert.match(flakeSrc, /bun test test\//, "checks run the bun suite under test/");
});

import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDuration,
  parseGates,
} from '../extension/lib/commands';
import {
  DEFAULT_SESSION_CONFIG,
  getEffectiveConfig,
  parseFileConfig,
} from '../extension/lib/config';
import { registerCommands } from '../extension/lib/commands';
import * as fsPromises from 'node:fs/promises';

describe('commands.test.ts - Parser Tests', () => {
  test('parseDuration parses minutes correctly', () => {
    assert.strictEqual(parseDuration('30m'), 1800000);
  });

  test('parseDuration parses hours correctly', () => {
    assert.strictEqual(parseDuration('1h'), 3600000);
  });

  test('parseDuration parses milliseconds correctly', () => {
    assert.strictEqual(parseDuration('500'), 500);
  });

  test('parseDuration returns null for invalid input', () => {
    assert.strictEqual(parseDuration('garbage'), null);
    assert.strictEqual(parseDuration('1d'), null); // Unsupported unit
    assert.strictEqual(parseDuration(''), null);
  });

  test('parseGates parses valid JSON array of strings', () => {
    assert.deepStrictEqual(parseGates('[\"cmd1\",\"cmd2\"]'), ['cmd1', 'cmd2']);
    assert.deepStrictEqual(parseGates('[]'), []);
  });

  test('parseGates returns null for "clear" keyword', () => {
    assert.strictEqual(parseGates('clear'), null);
    assert.strictEqual(parseGates('CLEAR'), null);
  });

  test('parseGates returns "error" for invalid JSON', () => {
    assert.strictEqual(parseGates('{ "cmd": "value" }'), 'error');
    assert.strictEqual(parseGates('[1,2]'), 'error'); // Not string array
    assert.strictEqual(parseGates('not json'), 'error');
  });
});

describe('commands.test.ts - Effective config precedence', () => {
  const base = {
    piHasUI: true,
    fileConfig: {},
    sessionOverrides: new Map(),
    envInt: (_name: string, fallback: number) => fallback,
    envStringArray: (_name: string) => [] as string[],
    DEFAULT_SESSION_CONFIG,
  };

  test('defaults apply when nothing else set', () => {
    const resolve = getEffectiveConfig({ ...base });
    assert.strictEqual(resolve('s1').maxContinuations, DEFAULT_SESSION_CONFIG.maxContinuations);
    assert.strictEqual(resolve('s1').gateCommands, null);
  });

  test('file config beats defaults', () => {
    const resolve = getEffectiveConfig({ ...base, fileConfig: { maxContinuations: 7 } });
    assert.strictEqual(resolve('s1').maxContinuations, 7);
  });

  test('env beats file', () => {
    const resolve = getEffectiveConfig({
      ...base,
      fileConfig: { maxContinuations: 7 },
      envInt: (name, fallback) => (name === 'OMP_AUTO_LOOP_MAX_CONTINUATIONS' ? 9 : fallback),
    });
    assert.strictEqual(resolve('s1').maxContinuations, 9);
  });

  test('session override beats env and file', () => {
    const overrides = new Map([['s1', { maxContinuations: 3 }]]);
    const resolve = getEffectiveConfig({
      ...base,
      fileConfig: { maxContinuations: 7 },
      envInt: (name, fallback) => (name === 'OMP_AUTO_LOOP_MAX_CONTINUATIONS' ? 9 : fallback),
      sessionOverrides: overrides,
    });
    assert.strictEqual(resolve('s1').maxContinuations, 3);
    assert.strictEqual(resolve('s2').maxContinuations, 9);
  });

  test('a dashboard limit beats env and file, and loses to a session override', () => {
    let live: { maxContinuations?: number } = { maxContinuations: 5 };
    const resolve = getEffectiveConfig({
      ...base,
      fileConfig: { maxContinuations: 7 },
      envInt: (name, fallback) => (name === 'OMP_AUTO_LOOP_MAX_CONTINUATIONS' ? 9 : fallback),
      sessionOverrides: new Map([['s1', { maxContinuations: 3 }]]),
      livePolicy: () => live,
    });
    assert.strictEqual(resolve('s2').maxContinuations, 5);
    assert.strictEqual(resolve('s1').maxContinuations, 3);
    // Read per call: a change on the dashboard lands on the next decision.
    live = {};
    assert.strictEqual(resolve('s2').maxContinuations, 9);
  });

  test('gate override replaces env gates', () => {
    const overrides = new Map([['s1', { gateCommands: ['override-cmd'] }]]);
    const resolve = getEffectiveConfig({
      ...base,
      envStringArray: (name) => (name === 'OMP_AUTO_LOOP_GATES' ? ['env-cmd'] : []),
      sessionOverrides: overrides,
    });
    assert.deepStrictEqual(resolve('s1').gateCommands, ['override-cmd']);
  });

  test('config.json: v1 keys are read, a supervised dashboard is opt-in, other versions are ignored', () => {
    assert.deepStrictEqual(parseFileConfig('{"version":1,"dashboardPort":8798,"graphApiPort":8799,"dashboardService":true}'), {
      dashboardPort: 8798,
      graphApiPort: 8799,
      dashboardService: true,
    });
    assert.deepStrictEqual(parseFileConfig('{"version":1,"dashboardService":"yes"}'), {});
    assert.deepStrictEqual(parseFileConfig('{"version":2,"dashboardPort":1}'), {});
    assert.throws(() => parseFileConfig('not json'));
  });
});

describe('commands.test.ts - doctor probes against a real tree', () => {
  const notify = (msg: string) => {
    captured.push(msg);
  };
  let captured: string[] = [];

  function buildPi() {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | null = null;
    const pi = {
      hasUI: true,
      registerCommand: (_name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        handler = opts.handler;
      },
    };
    // registerCommands needs the full surface; stub the unused parts.
    return { pi, run: async (args: string) => {
      assert.ok(handler, 'registerCommand was not called');
      await handler!(args, { hasUI: true, ui: { notify } });
    } };
  }

  test('doctor reports OK for a populated tree and FAIL for missing files, never throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autoloop-doctor-'));
    mkdirSync(join(root, 'config-home', 'omp-auto-loop'), { recursive: true });
    writeFileSync(join(root, 'config-home', 'omp-auto-loop', 'config.json'), '{"version":1,"dashboardPort":8799}');
    mkdirSync(join(root, 'state-home', 'omp-auto-loop'), { recursive: true });
    writeFileSync(join(root, 'state-home', 'omp-auto-loop', 'events.jsonl'), 'a\nb\n');
    // graph.lines deliberately absent.

    captured = [];
    let fetched = false;
    const { pi, run } = buildPi();
    const { registerCommands: rc } = { registerCommands };
    rc(
      pi as never,
      () => ({ ...DEFAULT_SESSION_CONFIG }),
      () => {},
      { get: () => ({ goalObjective: '', continuations: 0, maxContinuations: 3, cycleStartTime: Date.now(), gates: null, disabled: false, status: 'idle', paused: false }) },
      { newCycle() {}, disable() {}, enable() {}, setGoal() {}, setPaused() {} },
      join(root, 'config-home'),
      join(root, 'state-home'),
      join(root, 'cache-home'),
      fsPromises,
      async () => ({ ok: fetched = true, status: 200 }),
      (_cmd, cb) => { cb(null, '', ''); return {} as never; },
    );
    await run('doctor');

    const all = captured.join('\n');
    assert.match(all, /config\.json.*OK/);
    assert.match(all, /events\.jsonl.*OK \(2 lines\)/);
    assert.match(all, /graph\.lines.*FAIL/);
    assert.match(all, /jump-cannon graph-api.*OK/);
    assert.ok(fetched, 'healthz probe fetched');
  });

  test('status line renders goal, budget, and disabled state', async () => {
    captured = [];
    const { pi, run } = buildPi();
    const { registerCommands: rc } = { registerCommands };
    rc(
      pi as never,
      () => ({ ...DEFAULT_SESSION_CONFIG, maxContinuations: 4 }),
      () => {},
      { get: () => ({ goalObjective: 'ship it', continuations: 1, maxContinuations: 4, cycleStartTime: Date.now(), gates: null, disabled: true, status: 'active', paused: false }) },
      { newCycle() {}, disable() {}, enable() {}, setGoal() {}, setPaused() {} },
      '/nonexistent-config',
      '/nonexistent-state',
      '/nonexistent-cache',
      fsPromises,
      async () => ({ ok: true, status: 200 }),
      (_cmd, cb) => { cb(null, '', ''); return {} as never; },
    );
    await run('status');
    const all = captured.join('\n');
    assert.match(all, /ship it/);
    assert.match(all, /1\/4/);
    assert.match(all, /Disabled/);
  });
});

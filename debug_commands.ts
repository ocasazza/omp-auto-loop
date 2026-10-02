import {
  registerCommands,
} from './extension/lib/commands';

import {
  DEFAULT_SESSION_CONFIG,
  fileConfig,
  envInt,
  envStringArray,
  SESSION_OVERRIDES_KEY,
  XDG_CONFIG_HOME,
  XDG_STATE_HOME,
  XDG_CACHE_HOME,
  record,
  sessionKey as actualSessionKey,
  getEffectiveConfig as getEffectiveConfigFactory,
  type SessionConfig,
  type GoalState,
  type LoopActions,
} from './extension/auto-loop';

import { ExtensionCommandContext, AutocompleteItem, Pi } from '@oh-my-pi/pi-coding-agent';
import * as path from 'path';
import * as os from 'os';

// --- Manual Mocking for Debugging --- //

// Define a mock interface that extends Pi and includes the internal properties I need to inspect
interface DebugPi extends Pi {
  _commands: Map<string, any>;
  _entries: { customType: string; data: any }[];
  _messages: string[];
  readEntries: (customType: string) => Promise<{ customType: string; data: any }[]>;
}

const createMockPiForDebug = (): DebugPi => {
  const _commands = new Map<string, any>();
  const _entries: { customType: string; data: any }[] = [];
  const _messages: string[] = [];

  return {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { /* noop */ },
    registerTool: (tool: any) => { /* noop */ },
    appendEntry: (customType: string, data: any) => {
      _entries.push({ customType, data });
    },
    sendUserMessage: (content: string) => {
      _messages.push(content);
    },
    hasUI: false, // Assume headless for console output testing
    registerCommand: (name: string, opts: any) => {
      _commands.set(name, opts);
    },
    readEntries: async (customType: string) => {
      return _entries.filter(entry => entry.customType === customType);
    },
    // Expose the internal state for debugging/inspection
    _commands,
    _entries,
    _messages,
  } as DebugPi;
};

const createMockCtxForDebug = (cwd: string = process.cwd()): ExtensionCommandContext => {
  const _notifyMessages: { message: string; type?: 'note' | 'error' }[] = [];
  return {
    cwd,
    sessionManager: { getSessionId: () => 'debugSession' },
    _notifyMessages,
    ui: {
      notify: (message: string, type?: 'note' | 'error') => { console.log(`[UI.notify] ${message}`); _notifyMessages.push({ message, type }); },
      input: (title: string, placeholder?: string) => Promise.resolve(null),
      confirm: (title: string, message: string) => Promise.resolve(false),
      setStatus: (key: string, text: string) => { console.log(`[UI.setStatus] ${key}: ${text}`); },
      select: (title: string, items: any[], options?: any) => Promise.resolve(null),
    },
    hasUI: false,
  } as ExtensionCommandContext;
};

const XDG_MOCK_CONFIG_HOME = path.join(os.tmpdir(), 'xdg_config_mock');
const XDG_MOCK_STATE_HOME = path.join(os.tmpdir(), 'xdg_state_mock');
const XDG_MOCK_CACHE_HOME = path.join(os.tmpdir(), 'xdg_cache_mock');

const runDebug = async () => {
  console.log('--- Running Auto-loop Command Debugger ---');

  const pi = createMockPiForDebug();
  const ctx = createMockCtxForDebug();

  // Setup minimal loopState and actions for commands.ts
  let loopState = {
    goal: { objective: 'Test Goal', status: 'active' } as GoalState,
    continuations: 1,
    cycleStartTime: Date.now(),
    disabled: false,
    paused: false,
    lastCtx: ctx,
  };

  const mockSessionOverrides = new Map<string, Partial<SessionConfig>>();
  // To make sure getEffectiveConfig doesn't throw `undefined is not an object (evaluating 'sessionOverrides.get')`
  // when called by commands.ts via the getter, it needs access to the map.
  (globalThis as any)[SESSION_OVERRIDES_KEY.toString()] = mockSessionOverrides;

  const getEffective = getEffectiveConfigFactory({
    piHasUI: pi.hasUI,
    fileConfig: { dashboardPort: 9999 }, // Mock file config
    sessionOverrides: mockSessionOverrides,
    envInt,
    envStringArray,
    DEFAULT_SESSION_CONFIG,
  });

  const setOverride = (patch: Partial<SessionConfig> | null) => {
    const currentSessionId = actualSessionKey(loopState.lastCtx, record, (id: string) => id);
    if (patch === null) {
      mockSessionOverrides.delete(currentSessionId);
    } else {
      mockSessionOverrides.set(currentSessionId, { ...mockSessionOverrides.get(currentSessionId), ...patch });
    }
    console.log(`[DEBUG] Set override for ${currentSessionId}:`, patch);
  };

  const mockActions: LoopActions = {
    newCycle: () => { console.log('[DEBUG] newCycle called'); },
    disable: () => { loopState.disabled = true; console.log('[DEBUG] disable called'); },
    enable: () => { loopState.disabled = false; console.log('[DEBUG] enable called'); },
    setGoal: (text) => { loopState.goal.objective = text; loopState.goal.status = 'active'; console.log(`[DEBUG] setGoal called: ${text}`); },
    setPaused: (paused) => { loopState.paused = paused; console.log(`[DEBUG] setPaused called: ${paused}`); },
  };

  registerCommands(
    pi,
    () => getEffective('debugSession'),
    setOverride,
    { get: () => ({ ...loopState, goalObjective: loopState.goal.objective, status: loopState.goal.status, maxContinuations: getEffective('debugSession').maxContinuations, gates: getEffective('debugSession').gateCommands }) },
    mockActions,
    XDG_MOCK_CONFIG_HOME,
    XDG_MOCK_STATE_HOME,
    XDG_MOCK_CACHE_HOME
  );

  // --- Execute Commands --- //
  const autoloopCommand = pi._commands.get('autoloop');
  if (!autoloopCommand) {
    console.error('Error: /autoloop command not registered.');
    return;
  }

  console.log('\n--- Testing /autoloop status ---');
  await autoloopCommand.handler('status', ctx);

  console.log('\n--- Testing /autoloop budget 5 ---');
  await autoloopCommand.handler('budget 5', ctx);
  console.log('\n--- Testing /autoloop budget ---');
  await autoloopCommand.handler('budget', ctx);

  console.log('\n--- Testing /autoloop timeout 1h ---');
  await autoloopCommand.handler('timeout 1h', ctx);
  console.log('\n--- Testing /autoloop timeout ---');
  await autoloopCommand.handler('timeout', ctx);

  console.log('\n--- Testing /autoloop gates [\"build\",\"lint\"] ---');
  await autoloopCommand.handler('gates [\"build\",\"lint\"]', ctx);
  console.log('\n--- Testing /autoloop gates ---');
  await autoloopCommand.handler('gates', ctx);

  console.log('\n--- Testing /autoloop heartbeat off ---');
  await autoloopCommand.handler('heartbeat off', ctx);
  console.log('\n--- Testing /autoloop heartbeat ---');
  await autoloopCommand.handler('heartbeat', ctx);

  console.log('\n--- Testing /autoloop goal "Fix the bug" ---');
  await autoloopCommand.handler('goal "Fix the bug"', ctx);
  console.log('\n--- Testing /autoloop goal ---');
  await autoloopCommand.handler('goal', ctx);

  console.log('\n--- Testing /autoloop pause ---');
  await autoloopCommand.handler('pause', ctx);
  console.log('\n--- Testing /autoloop status (paused) ---');
  await autoloopCommand.handler('status', ctx);

  console.log('\n--- Testing /autoloop resume ---');
  await autoloopCommand.handler('resume', ctx);
  console.log('\n--- Testing /autoloop status (resumed) ---');
  await autoloopCommand.handler('status', ctx);

  console.log('\n--- Testing /autoloop disable ---');
  await autoloopCommand.handler('disable', ctx);
  console.log('\n--- Testing /autoloop status (disabled) ---');
  await autoloopCommand.handler('status', ctx);

  console.log('\n--- Testing /autoloop enable ---');
  await autoloopCommand.handler('enable', ctx);
  console.log('\n--- Testing /autoloop status (enabled) ---');
  await autoloopCommand.handler('status', ctx);

  // For doctor/stats, we need proper filesystem/network mocks which are problematic.
  // But we can at least ensure the handler is called without crashing.
  // To mock fs/fetch, we'd need a more complex setup which is out of scope for a quick debug run.
  console.log('\n--- Testing /autoloop doctor (expecting native FS/Fetch errors) ---');
  await autoloopCommand.handler('doctor', ctx);

  console.log('\n--- Testing /autoloop stats (expecting native FS errors) ---');
  await autoloopCommand.handler('stats', ctx);

  console.log('\n--- Manual Verification Complete ---');
  console.log('Messages sent via pi.sendUserMessage:', pi._messages);
  console.log('Entries appended via pi.appendEntry:', pi._entries);
  console.log('Notifications via ctx.ui.notify:', ctx._notifyMessages);
};

runDebug();

import type { ExtensionCommandContext, Pi, AutocompleteItem } from '@oh-my-pi/pi-coding-agent';
import type { SessionConfig } from './config';
import * as path from 'path';
import type { promises as fsType } from 'fs'; // Changed to type import
import type { exec as execType, ChildProcess } from 'child_process'; // Changed to type import
import { fileURLToPath } from 'url';

// Helper for cross-platform open - now accepts executor as dependency
const open = (executor: (command: string, cb: (error: Error | null, stdout: string, stderr: string) => void) => ChildProcess, url: string): Promise<{ stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
        const platform = process.platform;
        let command: string;
        if (platform === 'darwin') {
            command = `open "${url}"`;
        } else if (platform === 'linux') {
            command = `xdg-open "${url}"`;
        } else {
            command = `start "${url}"`; // Windows fallback
        }
        executor(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
};

// Helper for parsing duration strings like "30m", "1h", "500"
export const parseDuration = (input: string): number | null => {
    const match = input.match(/^(\d+)(m|h)?$/);
    if (!match) return null;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    return value;
};

// Helper for parsing gates array or 'clear'
export const parseGates = (input: string): string[] | null | 'error' => {
    if (input.toLowerCase() === 'clear') {
        return null;
    }
    try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
            return parsed;
        }
        return 'error'; // Not a string array
    } catch {
        return 'error'; // Invalid JSON
    }
};

// Helper to determine log output based on ctx.hasUI
const logOutput = (ctx: ExtensionCommandContext, message: string, type: 'note' | 'error' = 'note') => {
    if (ctx.hasUI) {
        ctx.ui.notify(message, type);
    } else {
        console.log(`[auto-loop] ${type.toUpperCase()}: ${message}`);
    }
};

export function registerCommands(
    pi: Pi,
    getEffective: () => SessionConfig,
    setOverride: (patch: Partial<SessionConfig> | null) => void,
    state: { get(): { goalObjective: string; continuations: number; maxContinuations: number; cycleStartTime: number; gates: string[] | null; disabled: boolean; status: string; paused: boolean } },
    actions: { newCycle(): void; disable(): void; enable(): void; setGoal(text: string): void; setPaused(paused: boolean): void },
    xdgConfigHome: string,
    xdgStateHome: string,
    xdgCacheHome: string,
    fsModule: fsType, // Injected fs/promises
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, // Injected fetcher
    executor: (command: string, cb: (error: Error | null, stdout: string, stderr: string) => void) => ChildProcess // Injected child_process.exec
): void {
    const commands = {
        async status(ctx: ExtensionCommandContext) {
            const loopState = state.get();
            const effectiveConfig = getEffective();
            const elapsedMs = Date.now() - loopState.cycleStartTime;
            const elapsed = elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(0)}s` : 'N/A';
            const message = `
Goal: ${loopState.goalObjective || 'None'} (${loopState.status})
Continuations: ${loopState.continuations}/${effectiveConfig.maxContinuations}
Elapsed: ${elapsed}
Gates: ${loopState.gates ? loopState.gates.join(', ') : 'None'}
Status: ${loopState.disabled ? 'Disabled' : loopState.paused ? 'Paused' : 'Enabled'}
            `.trim();
            logOutput(ctx, message);
        },

        async doctor(ctx: ExtensionCommandContext) {
            const results: string[] = [];
            const effectiveConfig = getEffective();

            // (a) config.json parseable
            const configPath = path.join(xdgConfigHome, 'omp-auto-loop', 'config.json');
            try {
                const configContent = await fsModule.readFile(configPath, 'utf8'); // Use injected fsModule
                JSON.parse(configContent);
                results.push(`config.json (${configPath}): OK (parseable)`);
            } catch (e: any) {
                results.push(`config.json (${configPath}): FAIL (${e.message})`);
            }

            // (b) events.jsonl exists and line count
            const eventsPath = path.join(xdgStateHome, 'omp-auto-loop', 'events.jsonl');
            try {
                const eventsContent = await fsModule.readFile(eventsPath, 'utf8'); // Use injected fsModule
                const lineCount = eventsContent.split('\n').filter(Boolean).length;
                results.push(`events.jsonl (${eventsPath}): OK (${lineCount} lines)`);
            } catch (e: any) {
                results.push(`events.jsonl (${eventsPath}): FAIL (${e.message})`);
            }

            // (c) graph.lines exists + line count
            const graphLinesPath = path.join(xdgCacheHome, 'omp-auto-loop', 'graph.lines');
            try {
                const graphLinesContent = await fsModule.readFile(graphLinesPath, 'utf8'); // Use injected fsModule
                const lineCount = graphLinesContent.split('\n').filter(Boolean).length;
                results.push(`graph.lines (${graphLinesPath}): OK (${lineCount} lines)`);
            } catch (e: any) {
                results.push(`graph.lines (${graphLinesPath}): FAIL (${e.message})`);
            }

            // (d) jump-cannon graph-api reachable
            const dashboardPort = effectiveConfig.dashboardPort;
            const healthzUrl = `http://127.0.0.1:${dashboardPort}/healthz`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5s timeout
            try {
                const response = await fetcher(healthzUrl, { signal: controller.signal }); // Use injected fetcher
                clearTimeout(timeoutId);
                if (response.ok) {
                    results.push(`jump-cannon graph-api (${healthzUrl}): OK`);
                } else {
                    results.push(`jump-cannon graph-api (${healthzUrl}): FAIL (HTTP ${response.status})`);
                }
            } catch (e: any) {
                clearTimeout(timeoutId);
                results.push(`jump-cannon graph-api (${healthzUrl}): FAIL (${e.message})`);
            }

            // (e) env OMP_AUTO_LOOP_* present list
            const envVars = Object.keys(process.env)
                .filter(key => key.startsWith('OMP_AUTO_LOOP_'))
                .map(key => `${key}=${process.env[key]}`);
            if (envVars.length > 0) {
                results.push(`OMP_AUTO_LOOP_* env vars: OK (${envVars.join(', ')})`);
            } else {
                results.push(`OMP_AUTO_LOOP_* env vars: None found`);
            }

            logOutput(ctx, results.join('\n'));
        },

        async openDashboard(ctx: ExtensionCommandContext) {
            const effectiveConfig = getEffective();
            const dashboardPort = effectiveConfig.dashboardPort;
            const url = `http://127.0.0.1:${dashboardPort}/`;
            try {
                await open(executor, url); // Pass injected executor to open helper
                logOutput(ctx, `Opened dashboard at ${url}`);
            } catch (e: any) {
                logOutput(ctx, `Failed to open dashboard at ${url}: ${e.message}`, 'error');
            }
        },

        async stats(ctx: ExtensionCommandContext) {
            const eventsPath = path.join(xdgStateHome, 'omp-auto-loop', 'events.jsonl');
            const counts: { [key: string]: number } = {};
            const eventPrefixes = [
                "settled: ", "gates passed", "heartbeat",
                "autonomous continuation", "gate failed"
            ];

            try {
                const eventsContent = await fsModule.readFile(eventsPath, 'utf8'); // Use injected fsModule
                const lines = eventsContent.split('\n').filter(Boolean);
                const last500Lines = lines.slice(-500);

                for (const line of last500Lines) {
                    let classified = false;
                    for (const prefix of eventPrefixes) {
                        if (line.includes(prefix)) {
                            counts[prefix] = (counts[prefix] || 0) + 1;
                            classified = true;
                            break;
                        }
                    }
                    if (!classified) {
                        counts['other'] = (counts['other'] || 0) + 1;
                    }
                }

                const loopState = state.get();
                let message = 'Auto-loop Stats (last 500 events):\n';
                for (const key in counts) {
                    message += `- ${key}: ${counts[key]}\n`;
                }
                message += `Continuations spent in current cycle: ${loopState.continuations}`;
                logOutput(ctx, message);

            } catch (e: any) {
                logOutput(ctx, `Failed to read events.jsonl: ${e.message}`, 'error');
            }
        },

        async budget(ctx: ExtensionCommandContext, args: string) {
            const effectiveConfig = getEffective();
            const loopState = state.get();
            if (args) {
                const n = parseInt(args, 10);
                if (!isNaN(n) && n >= 0) {
                    setOverride({ maxContinuations: n });
                    logOutput(ctx, `Max continuations set to: ${n}`);
                } else {
                    logOutput(ctx, `Invalid budget value: ${args}. Must be a non-negative number.`, 'error');
                }
            } else {
                logOutput(ctx, `Current max continuations: ${effectiveConfig.maxContinuations}. Used in current cycle: ${loopState.continuations}`);
            }
        },

        async timeout(ctx: ExtensionCommandContext, args: string) {
            const effectiveConfig = getEffective();
            if (args) {
                const ms = parseDuration(args);
                if (ms !== null && ms >= 0) {
                    setOverride({ timeoutMs: ms });
                    logOutput(ctx, `Timeout set to: ${ms}ms`);
                } else {
                    logOutput(ctx, `Invalid timeout value: ${args}. Use ms (e.g., 5000), "30m", or "1h".`, 'error');
                }
            } else {
                logOutput(ctx, `Current timeout: ${effectiveConfig.timeoutMs}ms`);
            }
        },

        async gates(ctx: ExtensionCommandContext, args: string) {
            const effectiveConfig = getEffective();
            if (args) {
                const parsed = parseGates(args);
                if (parsed === 'error') {
                    logOutput(ctx, `Invalid gates format: ${args}. Must be JSON array of strings or "clear".`, 'error');
                } else {
                    setOverride({ gateCommands: parsed });
                    logOutput(ctx, `Gates set to: ${parsed ? JSON.stringify(parsed) : 'cleared'}`);
                }
            } else {
                logOutput(ctx, `Current gates: ${effectiveConfig.gateCommands ? JSON.stringify(effectiveConfig.gateCommands) : 'None'}`);
            }
        },

        async heartbeat(ctx: ExtensionCommandContext, args: string) {
            const effectiveConfig = getEffective();
            if (args) {
                let ms: number | null = null;
                if (args.toLowerCase() === 'off') {
                    ms = 0;
                } else {
                    ms = parseDuration(args);
                }

                if (ms !== null && ms >= 0) {
                    setOverride({ heartbeatMs: ms });
                    logOutput(ctx, `Heartbeat set to: ${ms === 0 ? 'off' : `${ms}ms`}`);
                } else {
                    logOutput(ctx, `Invalid heartbeat value: ${args}. Use ms (e.g., 1000), "off", "30m", or "1h".`, 'error');
                }
            } else {
                logOutput(ctx, `Current heartbeat: ${effectiveConfig.heartbeatMs === 0 ? 'off' : `${effectiveConfig.heartbeatMs}ms`}`);
            }
        },

        async goal(ctx: ExtensionCommandContext, args: string) {
            const loopState = state.get();
            if (args) {
                actions.setGoal(args);
                logOutput(ctx, `Goal set to: "${args}"`);
            } else {
                logOutput(ctx, `Current goal: "${loopState.goalObjective || 'None'}"`);
            }
        },

        async pause(ctx: ExtensionCommandContext) {
            actions.setPaused(true);
            logOutput(ctx, `Auto-loop paused.`);
        },

        async resume(ctx: ExtensionCommandContext) {
            actions.setPaused(false);
            logOutput(ctx, `Auto-loop resumed.`);
        },

        async enable(ctx: ExtensionCommandContext) {
            actions.enable();
            logOutput(ctx, `Auto-loop enabled.`);
        },

        async disable(ctx: ExtensionCommandContext) {
            actions.disable();
            logOutput(ctx, `Auto-loop disabled.`);
        },
    };

    pi.registerCommand('autoloop', {
        description: 'Manage the autonomous loop behavior.',
        getArgumentCompletions: async (prefix: string, args: string): Promise<AutocompleteItem[]> => {
            const parts = args.trim().split(/\s+/);
            const subcommand = parts[0] || '';
            const subcommandArgs = parts.slice(1).join(' ');

            if (parts.length <= 1) { // Completing the subcommand itself
                return [
                    { value: 'status', label: 'status', description: 'Show current auto-loop status.' },
                    { value: 'doctor', label: 'doctor', description: 'Run diagnostics on auto-loop setup.' },
                    { value: 'open-dashboard', label: 'open-dashboard', description: 'Open the auto-loop dashboard.' },
                    { value: 'stats', label: 'stats', description: 'Show statistics from recent events.' },
                    { value: 'budget', label: 'budget', description: 'Get or set max continuations.' },
                    { value: 'timeout', label: 'timeout', description: 'Get or set autonomous loop timeout.' },
                    { value: 'gates', label: 'gates', description: 'Get or set gate commands.' },
                    { value: 'heartbeat', label: 'heartbeat', description: 'Get or set heartbeat interval.' },
                    { value: 'goal', label: 'goal', description: 'Get or set the current goal objective.' },
                    { value: 'pause', label: 'pause', description: 'Pause the autonomous loop.' },
                    { value: 'resume', label: 'resume', description: 'Resume the autonomous loop.' },
                    { value: 'enable', label: 'enable', description: 'Enable the autonomous loop.' },
                    { value: 'disable', label: 'disable', description: 'Disable the autonomous loop.' },
                ].filter(item => item.value.startsWith(prefix));
            }

            switch (subcommand) {
                case 'budget':
                    return ['10', '20', '50'].filter(v => v.startsWith(subcommandArgs)).map(v => ({ value: v, label: v }));
                case 'timeout':
                    return ['5000', '15000', '30s', '1m'].filter(v => v.startsWith(subcommandArgs)).map(v => ({ value: v, label: v }));
                case 'gates':
                    return ['["cmd1","cmd2"]', 'clear'].filter(v => v.startsWith(subcommandArgs)).map(v => ({ value: v, label: v }));
                case 'heartbeat':
                    return ['500', '1000', 'off'].filter(v => v.startsWith(subcommandArgs)).map(v => ({ value: v, label: v }));
                case 'goal':
                    return [{ value: 'Fix bug', label: 'Fix bug', description: 'Sample goal: fix a specific bug.' }, { value: 'Implement feature', label: 'Implement feature', description: 'Sample goal: implement a new feature.' }].filter(item => item.value.startsWith(subcommandArgs));
                default:
                    return [];
            }
        },
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const parts = args.trim().split(/\s+/);
            const subcommand = parts[0];
            const subcommandArgs = parts.slice(1).join(' ');

            switch (subcommand) {
                case 'status': await commands.status(ctx); break;
                case 'doctor': await commands.doctor(ctx); break;
                case 'open-dashboard': await commands.openDashboard(ctx); break;
                case 'stats': await commands.stats(ctx); break;
                case 'budget': await commands.budget(ctx, subcommandArgs); break;
                case 'timeout': await commands.timeout(ctx, subcommandArgs); break;
                case 'gates': await commands.gates(ctx, subcommandArgs); break;
                case 'heartbeat': await commands.heartbeat(ctx, subcommandArgs); break;
                case 'goal': await commands.goal(ctx, subcommandArgs); break;
                case 'pause': await commands.pause(ctx); break;
                case 'resume': await commands.resume(ctx); break;
                case 'enable': await commands.enable(ctx); break;
                case 'disable': await commands.disable(ctx); break;
                default:
                    logOutput(ctx, `Unknown /autoloop subcommand: ${subcommand}. Use /autoloop for options.`, 'error');
            }
        }
    });
}
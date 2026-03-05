#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { Bundle } from '../core/bundle/Bundle.js';
import { CommandDefinition, ILogger, IMutex, OutputMode } from '../core/interfaces.js';
import { ConsoleOutput } from '../core/commands/CommandOutput.js';
import { Container } from '../core/container/Container.js';
import { Worker } from '../core/queue/Worker.js';
import { queueCommands } from '../core/queue/Console/QueueCommands.js';
import { Bootstrap } from '../core/Bootstrap.js';

const program = new Command();

program
    .name('gears')
    .description('A specialized agentic worker framework for Node.js')
    .version('0.1.0')
    .option('--output <mode>', 'Output mode (text, json, silent, tui)')
    .option('--debug', 'Enable debug logs')
    .exitOverride();

// Parse known options early to apply --output/--debug before first boot
// This allows setting LoggerOptions before ILogger is resolved
program.parseOptions(process.argv);

/**
 * Boot the app with CLI options applied (e.g., output mode)
 */
async function bootWithOptions(): Promise<Container> {
    const opts = program.opts();

    // Resolve mode from flags
    let mode: OutputMode | undefined;
    if (opts.output && ['text', 'json', 'silent', 'tui'].includes(opts.output)) {
        mode = opts.output as OutputMode;
    }

    return Bootstrap.boot({
        mode,
        debug: opts.debug
    });
}

program
    .command('work')
    .description('Start the worker to process jobs and scheduled tasks')
    .option('-t, --timeout <seconds>', 'Run for specified seconds then gracefully exit')
    .option('-c, --concurrency <number>', 'Max concurrent jobs (default: 5)', '5')
    .option('--poll-interval-ms <number>', 'Poll interval in ms (overrides WORKER_POLL_INTERVAL_MS)')
    .option('--recovery-timeout-ms <number>', 'Recovery timeout in ms (overrides WORKER_RECOVERY_TIMEOUT_MS)')
    .option('--recovery-check-interval-ms <number>', 'Recovery check interval in ms (overrides WORKER_RECOVERY_CHECK_INTERVAL_MS)')
    .option('--heartbeat-interval-ms <number>', 'Heartbeat interval in ms (overrides WORKER_HEARTBEAT_INTERVAL_MS)')
    .action(async (options) => {
        const parsePositiveInt = (value: string | undefined, flagName: string): number | undefined => {
            if (value === undefined) return undefined;
            const parsed = parseInt(value, 10);
            if (isNaN(parsed) || parsed < 1) {
                throw new Error(`${flagName} must be a positive number`);
            }
            return parsed;
        };

        let concurrency: number;
        try {
            concurrency = parsePositiveInt(options.concurrency, '--concurrency') ?? 0;
        } catch (error) {
            console.error(`Error: ${(error as Error).message}`);
            process.exitCode = 1;
            return;
        }
        if (!concurrency) {
            console.error('Error: --concurrency must be a positive number');
            process.exitCode = 1;
            return;
        }

        let pollIntervalMs: number | undefined;
        let recoveryTimeoutMs: number | undefined;
        let recoveryCheckIntervalMs: number | undefined;
        let heartbeatIntervalMs: number | undefined;
        try {
            pollIntervalMs = parsePositiveInt(options.pollIntervalMs, '--poll-interval-ms');
            recoveryTimeoutMs = parsePositiveInt(options.recoveryTimeoutMs, '--recovery-timeout-ms');
            recoveryCheckIntervalMs = parsePositiveInt(options.recoveryCheckIntervalMs, '--recovery-check-interval-ms');
            heartbeatIntervalMs = parsePositiveInt(options.heartbeatIntervalMs, '--heartbeat-interval-ms');
        } catch (error) {
            console.error(`Error: ${(error as Error).message}`);
            process.exitCode = 1;
            return;
        }

        const app = await bootWithOptions();
        const logger = app.make('ILogger');

        // PID Locking
        const { PidLocker } = await import('../core/infra/PidLocker.js');
        const pidLocker = new PidLocker();
        try {
            pidLocker.acquire();
            logger.debug('Acquired PID lock');
        } catch (e: any) {
            logger.error('Failed to start worker', { error: e.message });
            process.exitCode = 1;
            return;
        }

        logger.info('Booting worker', { concurrency });

        // Configure worker options before resolving Worker
        app.singleton('WorkerOptions', () => ({
            maxConcurrency: concurrency,
            ...(pollIntervalMs !== undefined ? { pollInterval: pollIntervalMs } : {}),
            ...(recoveryTimeoutMs !== undefined ? { recoveryTimeoutMs } : {}),
            ...(recoveryCheckIntervalMs !== undefined ? { recoveryCheckIntervalMs } : {}),
            ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
        }));

        // Restore loaded bundles
        const bundleManager = app.make('BundleManager');
        await bundleManager.restore();

        const worker = app.make('Worker');
        worker.start();

        let shuttingDown = false;

        const gracefulShutdown = async () => {
            if (shuttingDown) {
                logger.warn('Forced exit (second signal)');
                process.exit(1);
            }
            shuttingDown = true;

            logger.info('Stopping worker...');
            try {
                await worker.stop();
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.error('Error stopping worker', { error: message });
            }

            try {
                // Run bundle-level shutdown hooks before container disposal.
                await bundleManager.unloadAll({ persist: false, silent: true });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.error('Error unloading bundles during shutdown', { error: message });
            }

            try {
                // Dispose all singletons (including AssistantService, CronScheduler, IMutex)
                await app.shutdown();
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.error('Error during app shutdown', { error: message });
            }

            pidLocker.release();
            logger.debug('Released PID lock');
            logger.info('Worker stopped gracefully');
            process.exitCode = 0;
        };

        // Handle graceful shutdown on signals
        process.on('SIGINT', gracefulShutdown);
        process.on('SIGTERM', gracefulShutdown);

        // Handle timeout if specified
        if (options.timeout) {
            const seconds = parseInt(options.timeout, 10);
            if (isNaN(seconds) || seconds <= 0) {
                logger.error('--timeout must be a positive number');
                process.exitCode = 1;
                return;
            }
            logger.info('Scheduled graceful exit', { seconds });
            setTimeout(gracefulShutdown, seconds * 1000);
        }
    });

program
    .command('load <path>')
    .description('Load and enable a bundle from a path')
    .action(async (bundlePath) => {
        const app = await bootWithOptions();
        const logger = app.make('ILogger');

        try {
            const bundleManager = app.make('BundleManager');
            // Persist only - do NOT boot in this CLI process. Let the worker pick it up via watch.
            await bundleManager.load(bundlePath, { boot: false, persist: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to load bundle', { error: message });
            process.exitCode = 1;
            return;
        }
    });

program
    .command('unload <name>')
    .description('Remove a bundle from config by name (worker will unload)')
    .action(async (name) => {
        const app = await bootWithOptions();
        const logger = app.make('ILogger');
        const bundleManager = app.make('BundleManager');
        const removed = await bundleManager.removeFromConfigByName(name);
        if (!removed) {
            logger.warn('Bundle not found in config', { bundle: name });
        }
    });

program
    .command('bundles')
    .description('List all enabled bundles')
    .action(async () => {
        const app = await bootWithOptions();
        const logger = app.make('ILogger');
        const bundleManager = app.make('BundleManager');
        // We need to restore first to populate the list from bundles.json since this is a fresh process
        // Use inspection mode: no watch, no boot (prevents starting cron jobs and watchers)
        await bundleManager.restore({ watch: false, boot: false });

        const bundles = bundleManager.getLoadedBundles();

        if (bundles.length === 0) {
            logger.info('No bundles loaded');
            return;
        }

        for (const bundle of bundles) {
            logger.info('Bundle', { name: bundle.name, version: bundle.version, path: bundle.path });
        }
    });



program
    .command('doctor')
    .description('Check system health and environment')
    .action(async () => {
        const app = await bootWithOptions();
        const logger = app.make('ILogger');
        const output = new ConsoleOutput();
        const ok = (text: string) => text;
        const warn = (text: string) => text;
        const err = (text: string) => text;
        const info = (text: string) => text;

        output.log('\nGears Doctor\n');

        // 1. System Check
        const nodeVersion = process.version;
        const parseSemver = (value: string): [number, number, number] => {
            const [major, minor, patch] = value.replace(/^v/, '').split('.');
            return [
                Number.parseInt(major ?? '0', 10) || 0,
                Number.parseInt(minor ?? '0', 10) || 0,
                Number.parseInt(patch ?? '0', 10) || 0,
            ];
        };
        const requiredNode: [number, number, number] = [20, 18, 1];
        const [curMajor, curMinor, curPatch] = parseSemver(nodeVersion);
        const [reqMajor, reqMinor, reqPatch] = requiredNode;
        const meetsRequirement =
            curMajor > reqMajor ||
            (curMajor === reqMajor && curMinor > reqMinor) ||
            (curMajor === reqMajor && curMinor === reqMinor && curPatch >= reqPatch);

        if (meetsRequirement) {
            output.log(`${ok('✓')} Node.js ${nodeVersion}`);
        } else {
            output.log(`${err('✗')} Node.js ${nodeVersion} (Required: >=20.18.1)`);
        }

        // 2. Config Check
        const fs = await import('fs');
        const path = await import('path');
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            output.log(`${ok('✓')} Configuration (.env found)`);
        } else {
            output.log(`${warn('!')} Configuration (.env missing)`);
        }

        // 3. Worker Status
        const { PidLocker } = await import('../core/infra/PidLocker.js');
        const pidLocker = new PidLocker();
        try {
            // Try to acquire. If it fails, worker is running.
            pidLocker.acquire();
            output.log(`${info('○')} Worker is STOPPED (Lock acquired)`);
            pidLocker.release();
        } catch (e: any) {
            if (e.message.includes('Worker already running')) {
                output.log(`${ok('✓')} Worker is RUNNING (PID locked)`);
            } else {
                output.log(`${err('✗')} Worker Lock Error: ${e.message}`);
            }
        }

        // 4. Database Check
        try {
            const queue = app.make('IQueue');
            await queue.stats();
            output.log(`${ok('✓')} Database Connection (SQLite)`);
        } catch (e: any) {
            output.log(`${err('✗')} Database Connection Failed: ${e.message}`);
        }

        // 5. Bundles
        const bundleManager = app.make('BundleManager');
        await bundleManager.restore({ watch: false, boot: false });
        const bundles = bundleManager.getLoadedBundles();
        if (bundles.length > 0) {
            output.log(`${ok('✓')} Bundles Loaded: ${bundles.length}`);
            bundles.forEach(b => output.log(`  - ${b.name} @ ${b.version}`));
        } else {
            output.log(`${info('○')} No Bundles Loaded`);
        }

        output.log('\nCheck complete.\n');
    });

// Top Command
program
    .command('top')
    .description('Monitor system status (TUI)')
    .action(async () => {
        const { Bootstrap } = await import('../core/Bootstrap.js');
        const app = await Bootstrap.boot({ mode: 'tui' });

        const { topCommand } = await import('./commands/top.js');
        await topCommand(app);
    });

// Store Commands
const store = program.command('store').description('Manage key-value storage');
store
    .command('dump')
    .description('Dump full storage as JSON')
    .action(async () => {
        const app = await bootWithOptions();
        const logger = app.make('ILogger');
        const output = new ConsoleOutput();
        const store = app.make('IStore');

        try {
            const data = await store.scan();
            output.log(JSON.stringify(data, null, 2));
        } catch (e: any) {
            logger.error('Failed to dump store', { error: e.message });
            process.exitCode = 1;
            return;
        }
    });

// --- Dynamic Bundle Command Registration ---

/**
 * Register commands from a bundle onto a Commander subcommand.
 * Bundles never interact with Commander directly - they only define CommandDefinition[].
 */
function registerBundleCommands(
    parentProgram: Command,
    bundleName: string,
    commands: CommandDefinition[],
    app: Container,
    bootBundle: () => Promise<any>
) {
    const sub = parentProgram
        .command(bundleName)
        .description(`Commands for ${bundleName} bundle`);

    for (const cmd of commands) {
        const cmdDef = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
        const c = sub.command(cmdDef).description(cmd.description);

        // Register options
        for (const opt of cmd.options ?? []) {
            if (opt.default !== undefined) {
                c.option(opt.flags, opt.description, opt.default);
            } else {
                c.option(opt.flags, opt.description);
            }
        }

        // Action handler - boots bundle before running
        c.action(async (...actionArgs: any[]) => {
            // Commander passes positional args first, then options object, then Command
            // We need to extract them properly
            const opts = actionArgs[actionArgs.length - 2] ?? {};

            // Build args object from positional args and options
            const args: Record<string, any> = { ...opts };

            // Extract positional argument names from cmd.args (e.g., '<value>' -> 'value')
            if (cmd.args) {
                const argNames = cmd.args.match(/<(\w+)>|\[(\w+)\]/g) ?? [];
                argNames.forEach((argName, idx) => {
                    const cleanName = argName.replace(/[<>\[\]]/g, '');
                    args[cleanName] = actionArgs[idx];
                });
            }

            // 0. Silence logger BEFORE booting bundles so TUI commands
            //    don't get boot-time log lines mixed into the blessed UI.
            // 0. Handle Output Mode
            // Check if command has a preferred mode or if user specified flags
            // If user specified --output, honor that.
            // Otherwise, respect cmd.preferredMode.

            const globalOpts = program.opts();
            const userSpecifiedMode = globalOpts.output;
            const preferredMode = cmd.preferredMode;

            // If user didn't override and command prefers a mode (e.g. tui), use it.
            if (!userSpecifiedMode && preferredMode) {
                const { PinoLogger } = await import('../core/infra/PinoLogger.js');
                app.singleton('ILogger', () => new PinoLogger({ mode: preferredMode }));
                app.singleton('LoggerOptions', () => ({ mode: preferredMode }));
            }
            await bootBundle();

            try {
                const output = new ConsoleOutput();
                await cmd.action(args, app, output);


                // Graceful Shutdown
                const bundleManager = app.make('BundleManager');
                const logger = app.make('ILogger');
                const bundles = bundleManager.getLoadedBundles();

                // 1. Unload bundles (runs bundle.shutdown hook)
                // We still do this because bundle.shutdown logic might be different from service disposal
                // (e.g. business logic cleanup vs resource cleanup)
                for (const record of bundles) {
                    try {
                        await bundleManager.unload(record.name, { persist: false, silent: true });
                    } catch (e) {
                        const message = e instanceof Error ? e.message : String(e);
                        logger.warn('Failed to unload bundle during CLI shutdown', { bundle: record.name, error: message });
                    }
                }

                // 2. Dispose all singletons (Connection pools, Schedulers, etc)
                // This is the new centralized disposal
                await app.shutdown();
                process.exitCode = 0;

            } catch (err) {
                console.error(err);
                process.exitCode = 1;
            }
        });
    }
}

// --- Main: Load bundles and register their commands ---

async function main() {
    const opts = program.opts();
    // Use bootWithOptions logic to resolve mode correctly
    let mode: OutputMode | undefined;
    if (opts.output) mode = opts.output as OutputMode;

    const app = await Bootstrap.boot({
        mode,
        debug: opts.debug
    });

    const bundleManager = app.make('BundleManager');

    // Load bundle metadata (no boot, no watch) to discover commands
    await bundleManager.restore({ watch: false, boot: false });

    const loadedBundles = bundleManager.getLoadedBundles() as Array<{
        name: string;
        version: string;
        path: string;
    }>;

    registerBundleCommands(
        program,
        'queue',
        queueCommands(),
        app,
        async () => app
    );

    // For each bundle with commands, register them
    for (const bundleInfo of loadedBundles) {
        try {
            // Dynamically import the bundle to get command definitions
            const bundleModule = await import(bundleInfo.path + '/index.js');
            const bundle: Bundle = bundleModule.bundle || bundleModule.default;

            if (bundle.commands?.length) {
                registerBundleCommands(
                    program,
                    bundle.name,
                    bundle.commands,
                    app,
                    async () => {
                        // Boot ALL bundles (registerOnly) so event listeners and services are available
                        // Bundles already restored above, just need to boot providers
                        for (const b of bundleManager.getLoadedBundles()) {
                            await bundleManager.load(b.path, { registerOnly: true, persist: false });
                        }
                        return app;
                    }
                );
            }

        } catch (err) {
            // Silently skip bundles that fail to load for command discovery
            // They might still work for the worker
        }
    }

    try {
        await program.parseAsync(process.argv);
    } catch (err: any) {
        // Commander throws CommanderError on --help, --version, and unknown commands.
        // exitCode 0 = normal (help/version), non-zero = user error (unknown command).
        if (err?.code === 'commander.helpDisplayed' || err?.code === 'commander.version') {
            process.exitCode = 0;
        } else if (err?.constructor?.name === 'CommanderError') {
            process.exitCode = err.exitCode ?? 1;
        } else {
            throw err; // unexpected — re-throw
        }
    }

    // Graceful shutdown: flush pino before exit
    try { await app.shutdown(); } catch { /* best-effort */ }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
});

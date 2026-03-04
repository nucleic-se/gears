import pino from 'pino';
import path from 'path';
import { ILogger, OutputMode } from '../interfaces.js';
import { ensureDataDir } from '../utils/paths.js';

export interface PinoLoggerOptions {
    mode?: OutputMode;
    debug?: boolean; // Enable debug level
}

export class PinoLogger implements ILogger {
    private logger: pino.Logger;

    constructor(options: PinoLoggerOptions = {}) {
        // Resolve mode from options
        let mode: OutputMode = options.mode || 'text';

        const streams: pino.StreamEntry[] = [];

        // Console stream logic
        // Only 'text' mode writes to stderr. output=json, silent, tui all suppress console logs.
        if (mode === 'text') {
            const usePretty = process.env.NODE_ENV !== 'production';
            streams.push(
                usePretty ? {
                    stream: pino.transport({
                        target: 'pino-pretty',
                        options: {
                            colorize: true,
                            translateTime: 'SYS:HH:MM:ss',
                            ignore: 'pid,hostname',
                            destination: 2 // 1 = stdout, 2 = stderr
                        }
                    })
                } : { stream: process.stderr }
            );
        }

        // File stream (Always) - ensure data dir exists
        try {
            const dataDir = ensureDataDir();
            streams.push({ stream: pino.destination(path.join(dataDir, 'app.log')) });
        } catch (e) {
            // If we can't write to file (e.g. read-only fs), we just don't add the stream
            // But if mode != text, we might have NO streams. That's fine (silent).
        }

        // Determine level
        let level = process.env.LOG_LEVEL || 'info';
        // In silent/json/tui modes, we might still want to log to file at 'info' level
        // But if 'silent' implies "don't even log to file?? No, usually silent means "quiet console".
        // The file log is always useful for debugging.

        if (options.debug) {
            level = 'debug';
        }

        this.logger = pino({
            level: level,
        }, pino.multistream(streams));
    }

    debug(message: string, context?: object): void {
        this.logger.debug(context || {}, message);
    }

    info(message: string, context?: object): void {
        this.logger.info(context || {}, message);
    }

    warn(message: string, context?: object): void {
        this.logger.warn(context || {}, message);
    }

    error(message: string, error?: Error | object): void {
        if (error instanceof Error) {
            this.logger.error({ err: error }, message);
        } else {
            const context: any = error || {};
            // Enhance: if context has 'error' which is an Error, map to 'err' for pino serialization
            if (context.error instanceof Error) {
                this.logger.error({ ...context, err: context.error }, message);
            } else {
                this.logger.error(context, message);
            }
        }
    }
}

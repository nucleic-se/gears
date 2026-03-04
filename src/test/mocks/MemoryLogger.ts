import { ILogger, LogLevel } from '../../core/interfaces.js';

export class MemoryLogger implements ILogger {
    public logs: Array<{ level: LogLevel; message: string; meta?: any }> = [];

    debug(message: string, meta?: any): void {
        this.log('debug', message, meta);
    }

    info(message: string, meta?: any): void {
        this.log('info', message, meta);
    }

    warn(message: string, meta?: any): void {
        this.log('warn', message, meta);
    }

    error(message: string, meta?: any): void {
        this.log('error', message, meta);
    }

    private log(level: LogLevel, message: string, meta?: any) {
        this.logs.push({ level, message, meta });
    }

    // Helper for assertions
    hasLog(level: LogLevel, messageFragment: string): boolean {
        return this.logs.some(l => l.level === level && l.message.includes(messageFragment));
    }

    clear() {
        this.logs = [];
    }
}

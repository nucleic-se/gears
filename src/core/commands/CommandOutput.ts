import { ICommandOutput } from '../interfaces.js';

export class ConsoleOutput implements ICommandOutput {
    log(message: string): void {
        console.log(message);
    }

    table(data: any[]): void {
        console.table(data);
    }

    error(message: string): void {
        console.error(message);
    }
}

export class BufferOutput implements ICommandOutput {
    private lines: string[] = [];

    log(message: string): void {
        this.lines.push(message);
    }

    table(data: any[]): void {
        if (Array.isArray(data) && data.length > 0) {
            const keys = Object.keys(data[0]);
            this.lines.push(`| ${keys.join(' | ')} |`);
            this.lines.push(`| ${keys.map(() => '---').join(' | ')} |`);
            for (const row of data) {
                const values = keys.map((k) => String(row?.[k] ?? ''));
                this.lines.push(`| ${values.join(' | ')} |`);
            }
            return;
        }
        this.lines.push(String(data));
    }

    error(message: string): void {
        this.lines.push(`[ERROR] ${message}`);
    }

    toString(): string {
        return this.lines.join('\n');
    }
}

import { appendFileSync } from 'node:fs';
import type { Container } from '../../src/core/container/Container.js';

export const events: string[] = [];
export let failBoot = false;
export function setFailBoot(value: boolean) { failBoot = value; }
declare module '../../src/core/services.js' {
    interface ServiceMap { '__NAME__': { close(): void } }
}
const name = '__NAME__';
class Provider {
    constructor(private app: Container) {}
    register() {
        this.app.singleton(name, () => {
            const timer = setInterval(() => {}, 1000);
            events.push('opened');
            return { close() {
                clearInterval(timer);
                events.push('closed');
                if (process.env.PROBE_MARKER) appendFileSync(process.env.PROBE_MARKER, 'closed\n');
            } };
        });
    }
    boot() {
        this.app.makeUnsafe(name);
        if (failBoot || process.env.PROBE_FAIL_BOOT === '1') throw new Error('probe boot failed');
    }
}
export default {
    name,
    version: '1.0.0',
    requires: [] as string[],
    providers: [Provider],
    commands: [{ name: 'fail', description: 'Failure probe', action() { throw new Error('probe command failed'); } }],
};

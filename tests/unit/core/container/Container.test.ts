import { describe, it, expect, vi } from 'vitest';
import { Container } from '../../../../src/core/container/Container';

describe('Container', () => {
    it('should dispose services in LIFO order (reverse resolution)', async () => {
        const disposeLog: string[] = [];
        const container = new Container();

        class ServiceA {
            dispose() { disposeLog.push('A'); }
        }
        class ServiceB {
            constructor(public a: ServiceA) { }
            dispose() { disposeLog.push('B'); }
        }
        class ServiceC {
            constructor(public b: ServiceB) { }
            dispose() { disposeLog.push('C'); }
        }

        container.singleton('A' as any, () => new ServiceA());
        container.singleton('B' as any, (c) => new ServiceB(c.make('A' as any)));
        container.singleton('C' as any, (c) => new ServiceC(c.make('B' as any)));

        // Resolve C -> B -> A
        container.make('C' as any);

        await container.shutdown();

        expect(disposeLog).toEqual(['C', 'B', 'A']);
    });

    it('should not dispose unbound services (memory leak fix)', async () => {
        const disposeLog: string[] = [];
        const container = new Container();

        class DisposableService {
            constructor(public name: string) { }
            dispose() { disposeLog.push(this.name); }
        }

        container.singleton('Test' as any, () => new DisposableService('Original'));

        // Resolve it so it gets added to shutdownStack
        container.make('Test' as any);

        // Rebind -> Should remove 'Original' from shutdownStack
        container.singleton('Test' as any, () => new DisposableService('Replacement'));

        // Resolve replacement
        container.make('Test' as any);

        await container.shutdown();

        // Should ONLY dispose 'Replacement', NOT 'Original'
        expect(disposeLog).toEqual(['Replacement']);
    });

    it('should replace singleton instance when re-registered', () => {
        const app = new Container();
        const key = 'TestService';

        // 1. Register first implementation
        class ServiceA { name = 'A'; }
        app.singleton(key as any, () => new ServiceA());

        // Use makeUnsafe or cast to any if make is strictly typed in your version
        // Assuming makeUnsafe exists based on previous file content
        const instance1 = app.makeUnsafe<ServiceA>(key);
        expect(instance1.name).toBe('A');

        // 2. Re-register (Overwrite)
        class ServiceB { name = 'B'; }
        app.singleton(key as any, () => new ServiceB());

        // 3. Should get NEW instance
        const instance2 = app.makeUnsafe<ServiceB>(key);
        expect(instance2.name).toBe('B');

        // Ensure strictly different instances
        expect(instance1).not.toBe(instance2);
    });

    it('should replace singleton with binding when re-bound', () => {
        const app = new Container();
        const key = 'TestService';

        app.singleton(key as any, () => ({ type: 'singleton' }));
        expect(app.makeUnsafe<any>(key).type).toBe('singleton');

        // Re-bind as factory
        app.bind(key as any, () => ({ type: 'binding' }));

        const instance = app.makeUnsafe<any>(key);
        expect(instance.type).toBe('binding');
    });
});

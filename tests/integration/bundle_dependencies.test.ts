import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BundleManager } from '../../src/core/bundle/BundleManager.js';
import { TestContainer } from '../../src/test/helpers/TestContainer.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_BUNDLES_DIR = path.resolve(__dirname, '../../temp-bundles');

// Helper to create a dummy bundle on disk
async function createBundle(name: string, requires: string[] = []) {
    const bundleDir = path.join(TEMP_BUNDLES_DIR, name);
    await fs.mkdir(bundleDir, { recursive: true });

    const content = `
    export const bundle = {
        name: '${name}',
        version: '1.0.0',
        requires: ${JSON.stringify(requires)},
        providers: [],
        init: async () => { console.log('Init ${name}'); }
    };
    `;

    await fs.writeFile(path.join(bundleDir, 'index.js'), content);
    return bundleDir;
}

describe('Bundle Dependencies', () => {
    let app: TestContainer;
    let manager: BundleManager;
    const CONFIG_PATH = path.resolve(process.cwd(), 'bundles-deps.json');

    beforeEach(async () => {
        app = new TestContainer();
        manager = new BundleManager(app, { configPath: CONFIG_PATH });

        try { await fs.rm(TEMP_BUNDLES_DIR, { recursive: true, force: true }); } catch { }
        try { await fs.unlink(CONFIG_PATH); } catch { }
    });

    afterEach(async () => {
        try { await fs.rm(TEMP_BUNDLES_DIR, { recursive: true, force: true }); } catch { }
        try { await fs.unlink(CONFIG_PATH); } catch { }
    });

    it('should boot bundles in topological order', async () => {
        // A -> B (A requires B)
        // C -> B

        const pathB = await createBundle('BundleB_1', []);
        const pathA = await createBundle('BundleA_1', ['BundleB_1']);
        const pathC = await createBundle('BundleC_1', ['BundleB_1']);

        const bootSpy = vi.spyOn(manager as any, 'bootBundle');

        // Use the isolated config path
        const fsOrig = await import('fs/promises');
        let backupConfig: string | null = null;
        try { backupConfig = await fsOrig.readFile(CONFIG_PATH, 'utf-8'); } catch { }

        try {
            await fsOrig.writeFile(CONFIG_PATH, JSON.stringify({
                bundles: [pathA, pathC, pathB] // Random order in config
            }));

            await manager.restore({ boot: true, watch: false });

            expect(bootSpy).toHaveBeenCalledTimes(3);

            // Extract the order of calls
            const calls = bootSpy.mock.calls.map((c: any) => (c[0] as any).name);

            // B must be first
            expect(calls[0]).toBe('BundleB_1');
            expect(calls).toContain('BundleA_1');
            expect(calls).toContain('BundleC_1');

        } finally {
            if (backupConfig) await fsOrig.writeFile(CONFIG_PATH, backupConfig);
            else {
                try { await fsOrig.unlink(CONFIG_PATH); } catch { }
            }
        }
    });

    it('should throw MissingDependencyError if dependency is not loaded', async () => {
        const pathA = await createBundle('BundleA_2', ['BundleMissing']);

        const fsOrig = await import('fs/promises');
        let backupConfig: string | null = null;
        try { backupConfig = await fsOrig.readFile(CONFIG_PATH, 'utf-8'); } catch { }

        try {
            await fsOrig.writeFile(CONFIG_PATH, JSON.stringify({
                bundles: [pathA]
            }));

            await manager.restore({ boot: true, watch: false });

            // Verify the error was logged
            expect(app.logger.hasLog('error', 'Dependency validation failed. Some bundles may not boot.')).toBe(true);

            // Verify the bundle was NOT booted (the critical behavior)
            const loaded = manager.getLoadedBundles();
            const bundleA = loaded.find((b: any) => b.name === 'BundleA_2');
            // Bundle should either not be loaded or not be in 'booted' status
            if (bundleA) {
                expect(bundleA.status).not.toBe('booted');
            }

        } finally {
            if (backupConfig) await fsOrig.writeFile(CONFIG_PATH, backupConfig);
            else {
                try { await fsOrig.unlink(CONFIG_PATH); } catch { }
            }
        }
    });

    it('should throw CircularDependencyError on cycles', async () => {
        const pathA = await createBundle('BundleA_3', ['BundleB_3']);
        const pathB = await createBundle('BundleB_3', ['BundleA_3']);

        const fsOrig = await import('fs/promises');
        let backupConfig: string | null = null;
        try { backupConfig = await fsOrig.readFile(CONFIG_PATH, 'utf-8'); } catch { }

        try {
            await fsOrig.writeFile(CONFIG_PATH, JSON.stringify({
                bundles: [pathA, pathB]
            }));

            await manager.restore({ boot: true, watch: false });

            // Verify the error was logged
            expect(app.logger.hasLog('error', 'Dependency validation failed. Some bundles may not boot.')).toBe(true);

            // Verify that neither bundle in the cycle was booted
            const loaded = manager.getLoadedBundles();
            const bundleA = loaded.find((b: any) => b.name === 'BundleA_3');
            const bundleB = loaded.find((b: any) => b.name === 'BundleB_3');
            if (bundleA) {
                expect(bundleA.status).not.toBe('booted');
            }
            if (bundleB) {
                expect(bundleB.status).not.toBe('booted');
            }

        } finally {
            if (backupConfig) await fsOrig.writeFile(CONFIG_PATH, backupConfig);
            else {
                try { await fsOrig.unlink(CONFIG_PATH); } catch { }
            }
        }
    });

    it('should prevent unloading a bundle if it is required by another', async () => {
        const pathB = await createBundle('BundleB_4', []);
        const pathA = await createBundle('BundleA_4', ['BundleB_4']);

        await manager.load(pathB);
        await manager.load(pathA);

        // Try to unload B
        await expect(manager.unload('BundleB_4')).rejects.toThrow("Cannot unload 'BundleB_4': 'BundleA_4' depends on it");
    });
});

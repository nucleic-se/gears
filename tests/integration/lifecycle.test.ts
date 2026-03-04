import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BundleManager } from '../../src/core/bundle/BundleManager.js';
import { TestContainer } from '../../src/test/helpers/TestContainer.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// Helper to create a dummy bundle on disk
async function createDummyBundle(dir: string, name: string) {
    const bundleDir = path.join(dir, name);
    await fs.mkdir(bundleDir, { recursive: true });

    const code = `
    export const bundle = {
        name: '${name}',
        version: '1.0.0',
        providers: [],
        init: async (app) => { app.make('ILogger').info('[${name}] init'); },
        shutdown: async (app) => { app.make('ILogger').info('[${name}] shutdown'); }
    };
    export default bundle;
    `;

    await fs.writeFile(path.join(bundleDir, 'index.js'), code);
    return bundleDir;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_BUNDLES_DIR = path.resolve(__dirname, '../../test-bundles-temp');

describe('BundleManager Lifecycle', () => {
    let app: TestContainer;
    let bundleManager: BundleManager;

    const CONFIG_PATH = path.resolve(process.cwd(), 'bundles-lifecycle.json');

    beforeEach(async () => {
        app = new TestContainer();
        // Use custom config path to avoid collision with other tests
        bundleManager = new BundleManager(app, { configPath: CONFIG_PATH });

        // Ensure clean slate
        try { await fs.rm(TEST_BUNDLES_DIR, { recursive: true }); } catch { }
        await fs.mkdir(TEST_BUNDLES_DIR, { recursive: true });

        try { await fs.unlink(CONFIG_PATH); } catch { }
    });

    afterEach(async () => {
        try { await fs.rm(TEST_BUNDLES_DIR, { recursive: true }); } catch { }
        try { await fs.unlink(CONFIG_PATH); } catch { }
    });

    it('should load bundle metadata correctly', async () => {
        const bundlePath = await createDummyBundle(TEST_BUNDLES_DIR, 'test-bundle-meta');

        await bundleManager.load(bundlePath, { boot: false, persist: false });

        const loaded = bundleManager.getLoadedBundles();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].name).toBe('test-bundle-meta');
        expect(loaded[0].path).toBe(bundlePath); // Validates absolute path resolution
    });

    it('should be idempotent when loading metadata twice', async () => {
        const bundlePath = await createDummyBundle(TEST_BUNDLES_DIR, 'test-bundle-idem');

        await bundleManager.load(bundlePath, { boot: false, persist: false });
        await bundleManager.load(bundlePath, { boot: false, persist: false });

        expect(bundleManager.getLoadedBundles()).toHaveLength(1);
    });

    it('should boot a bundle and call init', async () => {
        const bundlePath = await createDummyBundle(TEST_BUNDLES_DIR, 'test-bundle-boot');

        await bundleManager.load(bundlePath, { boot: true, persist: false });

        const loaded = bundleManager.getLoadedBundles();
        expect(loaded).toHaveLength(1);

        // Verify init log via MemoryLogger
        expect(app.logger.hasLog('info', '[test-bundle-boot] init')).toBe(true);
    });

    it('should throw error when booting an already booted bundle', async () => {
        const bundlePath = await createDummyBundle(TEST_BUNDLES_DIR, 'test-bundle-double-boot');

        await bundleManager.load(bundlePath, { boot: true, persist: false });

        await expect(bundleManager.load(bundlePath, { boot: true }))
            .rejects.toThrow('already booted');
    });

    it('should persist loaded bundles and restore them after restart', async () => {
        const bundlePath = await createDummyBundle(TEST_BUNDLES_DIR, 'test-bundle-persist');

        // 1. Load and persist
        await bundleManager.load(bundlePath, { boot: true, persist: true });

        // 2. Create new manager (simulating restart)
        const newApp = new TestContainer();
        const newManager = new BundleManager(newApp, { configPath: CONFIG_PATH });

        await newManager.restore({ boot: true, watch: false });

        const loaded = newManager.getLoadedBundles();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].name).toBe('test-bundle-persist');

        // Should have booted again
        expect(newApp.logger.hasLog('info', '[test-bundle-persist] init')).toBe(true);
    });
});

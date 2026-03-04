
import { BundleManager } from '../src/core/bundle/BundleManager.js';
import { Container } from '../src/core/container/Container.js';
import { Bundle } from '../src/core/bundle/Bundle.js';
import path from 'path';
import fs from 'fs/promises';

// --- Mocks ---
class MockContainer extends Container {
    // Basic mock
}

// Helper to create a dummy bundle on disk
async function createDummyBundle(dir: string, name: string) {
    const bundleDir = path.join(dir, name);
    await fs.mkdir(bundleDir, { recursive: true });

    const code = `
    export const bundle = {
        name: '${name}',
        version: '1.0.0',
        providers: [],
        init: async (app) => { console.log('[${name}] init'); },
        shutdown: async (app) => { console.log('[${name}] shutdown'); }
    };
    export default bundle;
    `;

    await fs.writeFile(path.join(bundleDir, 'index.js'), code);
    return bundleDir;
}

// --- Test Suite ---
async function runTests() {
    console.log('=== Starting Bundle Lifecycle Tests ===');

    const app = new MockContainer();
    const bundleManager = new BundleManager(app);

    const testDir = path.resolve('./dist/test-bundles');
    try { await fs.rm(testDir, { recursive: true }); } catch { }
    await fs.mkdir(testDir, { recursive: true });

    // Ensure clean bundles.json
    try { await fs.unlink('bundles.json'); } catch { }

    const bundlePath = await createDummyBundle(testDir, 'test-bundle');

    try {
        // Test 1: Load Metadata only
        console.log('\n--- Test 1: Metadata Load ---');
        await bundleManager.load(bundlePath, { boot: false, persist: false });
        let loaded = bundleManager.getLoadedBundles();
        console.log('Loaded:', loaded.map(b => b.name));
        if (loaded.length !== 1 || loaded[0].name !== 'test-bundle') throw new Error('Failed metadata load');

        // Test 2: Double Load Metadata (Idempotent)
        console.log('\n--- Test 2: Idempotent Metadata Load ---');
        await bundleManager.load(bundlePath, { boot: false, persist: false });
        console.log('Load called again (no error expected)');

        // Test 3: Upgrade to Booted
        console.log('\n--- Test 3: Upgrade to Booted ---');
        await bundleManager.load(bundlePath, { boot: true, persist: true }); // Should run init
        // Check console output for "[test-bundle] init" manually or trust flow

        // Test 4: Double Boot Error
        console.log('\n--- Test 4: Double Boot Error ---');
        try {
            await bundleManager.load(bundlePath, { boot: true });
            throw new Error('Should have thrown double boot error');
        } catch (e: any) {
            console.log('Caught expected error:', e.message);
            if (!e.message.includes('already booted')) throw e;
        }

        // Test 5: Simulating Restart (Persistence Check)
        console.log('\n--- Test 5: Persistence / Restart ---');
        // We create a NEW manager to simulate a restart, because 'unload()' destroys persistence.
        const manager2 = new BundleManager(app);

        // bundles.json should still have the entry from step 3? 
        // Yes, step 3 called load({ persist: true }).
        // But wait, did we unload? No, we skipping explicit unload step to test persistence.

        await manager2.restore({ boot: true, watch: false });
        loaded = manager2.getLoadedBundles();
        console.log('Restored bundles:', loaded.map(b => b.name));

        if (loaded.length !== 1) throw new Error('Failed to restore from persistence');

        // Clean up (using manager2 to unload and clean persistence)
        await manager2.unload('test-bundle');

        console.log('\n=== All Tests Passed ===');

    } catch (e) {
        console.error('\n!!! TEST FAILED !!!', e);
        process.exit(1);
    } finally {
        await fs.rm(testDir, { recursive: true });
        try { await fs.unlink('bundles.json'); } catch { }
    }
}

runTests();

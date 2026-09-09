import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codingTools } from '../src/standalone/coding.js';

it('uses shared validation, editing and command results through the host adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gears-coding-'));
    try {
        await writeFile(join(root, 'value.txt'), 'before');
        const tools = codingTools(root, join(root, 'outputs'));
        const patch = tools.find(tool => tool.definition.name === 'fs_patch')!;
        expect(patch.effect).toBe('write');
        const args = patch.validate({ path: 'value.txt', patches: [{ search: 'before', replace: 'after' }] });
        expect((await patch.execute(args, new AbortController().signal)).ok).toBe(true);
        expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('after');
        expect(() => patch.validate({ path: '../outside', patches: [{ search: 'x', replace: 'y' }] })).toThrow();
        const shell = tools.find(tool => tool.definition.name === 'shell_run')!;
        const checked = shell.validate({ command: 'node -e "process.exit(7)"' });
        expect(await shell.execute(checked, new AbortController().signal)).toMatchObject({ ok: false, data: { exitCode: 7 } });
        expect(codingTools(root, join(root, 'outputs'), true).every(tool => tool.effect === 'read')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('passes shared image attachments and empty-root shell arguments without host-specific translation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gears-image-'));
    try {
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nqAAAAAASUVORK5CYII=', 'base64');
        await writeFile(join(root, 'capture.png'), image);
        const tools = codingTools(root, join(root, 'outputs'));
        const read = tools.find(tool => tool.definition.name === 'fs_read')!;
        const result = await read.execute(read.validate({ path: 'capture.png' }), new AbortController().signal);
        expect(result).toMatchObject({ ok: true, contentBlocks: [
            { type: 'text', text: result.content }, { type: 'image', mimeType: 'image/png', data: image.toString('base64') },
        ] });
        const shell = tools.find(tool => tool.definition.name === 'shell_run')!;
        expect(await shell.execute(shell.validate({ command: 'pwd', cwd: '' }), new AbortController().signal)).toMatchObject({ ok: true });
    } finally { await rm(root, { recursive: true, force: true }); }
});

import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RateLimitedFetcher } from '../../src/core/infra/RateLimitedFetcher.js';

it.each([429, 503])('cancels the unfinished %s response before retrying', async status => {
    let requests = 0;
    let cancelled = false;
    const server = createServer((_request, response) => {
        if (++requests === 1) {
            response.writeHead(status, { 'retry-after': '0' });
            response.write('unfinished body');
            response.on('close', () => { cancelled = true; });
        } else response.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const fetcher = new RateLimitedFetcher(0);
    try {
        const address = server.address() as { port: number };
        expect((await fetcher.get(`http://127.0.0.1:${address.port}`, { retries: 1 })).body).toBe('ok');
        expect(cancelled).toBe(true);
    } finally {
        server.closeAllConnections();
        await fetcher.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

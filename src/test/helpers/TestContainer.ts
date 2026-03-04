import { Container } from '../../core/container/Container.js';
import { MemoryLogger } from '../mocks/MemoryLogger.js';
import { MemoryStore } from '../mocks/MemoryStore.js';

export class TestContainer extends Container {
    public readonly logger: MemoryLogger;
    public readonly store: MemoryStore;

    constructor() {
        super();

        this.logger = new MemoryLogger();
        this.singleton('ILogger', () => this.logger);

        this.store = new MemoryStore();
        this.singleton('IStore', () => this.store);
    }
}

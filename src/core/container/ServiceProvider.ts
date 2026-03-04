import { Container } from './Container.js';

export abstract class ServiceProvider {
    protected app: Container;

    constructor(app: Container) {
        this.app = app;
    }

    abstract register(): void;

    async boot(): Promise<void> {
        // Optional boot logic
    }
}

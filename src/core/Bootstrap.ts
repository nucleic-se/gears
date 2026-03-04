import { ILogger, OutputMode } from './interfaces.js';
import { Container } from './container/Container.js';
import { boot } from '../index.js';

export interface BootstrapOptions {
    mode?: OutputMode;
    debug?: boolean;
}

export class Bootstrap {
    /**
     * Boot the application with the given options.
     * Creates a fresh Container, configures logging, and boots core services.
     */
    static async boot(options: BootstrapOptions = {}): Promise<Container> {
        const app = new Container();

        // Configure LoggerOptions before core boot so ILogger picks them up
        app.singleton('LoggerOptions', () => ({
            mode: options.mode,
            debug: options.debug
        }));

        await boot(app);

        return app;
    }
}

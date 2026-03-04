import { Container } from '../container/Container.js';
import { ServiceProvider } from '../container/ServiceProvider.js';
import { CommandDefinition } from '../interfaces.js';

export interface Bundle {
    name: string;
    version: string;
    providers: Array<new (app: Container) => ServiceProvider>;

    /** CLI commands exposed by this bundle (optional) */
    commands?: CommandDefinition[];

    /** Optional description of the bundle (shown in /help) */
    description?: string;

    /** List of bundle names that this bundle depends on (must be booted first) */
    requires?: string[];

    init?(app: Container): Promise<void>;
    shutdown?(app: Container): Promise<void>;
}

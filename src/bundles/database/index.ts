import { Bundle } from '../../core/bundle/Bundle.js';
import { DatabaseServiceProvider } from './DatabaseServiceProvider.js';
import { Kysely } from 'kysely';

declare module '../../core/services.js' {
    interface ServiceMap {
        'db': Kysely<any>;
    }
}

export const bundle: Bundle = {
    name: 'database',
    version: '0.1.0',
    providers: [DatabaseServiceProvider]
};

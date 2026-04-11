import { Bundle } from '../../core/bundle/Bundle.js';
import { DatabaseServiceProvider } from './DatabaseServiceProvider.js';
import { Kysely } from 'kysely';

export interface DatabaseSchema {}
export type DatabaseConnection = Kysely<DatabaseSchema>;

declare module '../../core/services.js' {
    interface ServiceMap {
        'db': DatabaseConnection;
    }
}

export { DatabaseServiceProvider };

export const bundle: Bundle = {
    name: 'database',
    version: '0.1.0',
    providers: [DatabaseServiceProvider]
};

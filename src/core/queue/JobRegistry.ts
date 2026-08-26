import { ILogger } from '../interfaces.js';
import type { IJobRegistry, JobDefinition, ValidationSchema } from './interfaces.js';

export class JobValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JobValidationError';
    }
}

export class JobRegistry implements IJobRegistry {
    private definitions = new Map<string, JobDefinition>();
    private logger: ILogger;

    constructor(logger: ILogger) {
        this.logger = logger;
    }

    register<T>(type: string, schema?: ValidationSchema<T>, description?: string): void {
        this.definitions.set(type, { type, schema, description });
        this.logger.debug(`Registered job type: ${type}`);
    }

    get(type: string): JobDefinition | undefined {
        return this.definitions.get(type);
    }

    validate(type: string, payload: any): { valid: boolean; error?: string } {
        const def = this.definitions.get(type);
        if (!def || !def.schema) {
            return { valid: true }; // No schema = valid
        }

        const result = def.schema.safeParse(payload);
        if (result.success) {
            return { valid: true };
        } else {
            return { valid: false, error: result.error.message };
        }
    }
}

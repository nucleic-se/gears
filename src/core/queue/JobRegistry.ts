import { ZodSchema } from 'zod';
import { ILogger } from '../interfaces.js';

export class JobValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JobValidationError';
    }
}

export interface JobDefinition<T = any> {
    type: string;
    schema?: ZodSchema<T>;
    description?: string;
}

export class JobRegistry {
    private definitions = new Map<string, JobDefinition>();
    private logger: ILogger;

    constructor(logger: ILogger) {
        this.logger = logger;
    }

    register<T>(type: string, schema?: ZodSchema<T>, description?: string): void {
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

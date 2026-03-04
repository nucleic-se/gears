import { Container } from '../container/Container.js';
import { IAIActionRegistry, AIAction } from './interfaces.js';

export class AIActionRegistry implements IAIActionRegistry {
    private actions = new Map<string, AIAction>();

    constructor(private container: Container) {}

    register(action: AIAction): void {
        this.actions.set(action.name, action);
    }

    get(name: string): AIAction | undefined {
        return this.actions.get(name);
    }

    getTools(): AIAction[] {
        return Array.from(this.actions.values());
    }

    async execute(name: string, params: any): Promise<any> {
        const action = this.actions.get(name);
        if (!action) throw new Error('Action not found: ' + name);

        const validationError = this.validateParams(action, params);
        if (validationError) {
            throw new Error(`Invalid params for action '${name}': ${validationError}`);
        }

        return await action.handler(params);
    }

    private validateParams(action: AIAction, params: any): string | null {
        const schema: any = (action as any).schema;

        if (!schema || typeof schema === 'string') {
            // No validation or description-only schema
            return null;
        }

        if (typeof schema.safeParse === 'function') {
            const result = schema.safeParse(params);
            return result.success ? null : result.error?.message || 'Schema validation failed';
        }

        if (typeof schema.parse === 'function') {
            try {
                schema.parse(params);
                return null;
            } catch (e: any) {
                return e?.message || 'Schema validation failed';
            }
        }

        // Unknown schema format: do not block.
        return null;
    }
}

/**
 * AI builder interfaces — re-exported from @nucleic-se/agentic,
 * plus tool/action registry contracts.
 */

export type {
    IAIPromptBuilder,
    IAIPromptService,
    IAIPipeline,
    PipelineOptions,
} from '@nucleic-se/agentic/contracts';

export interface AIAction {
    name: string;
    description: string;
    schema: string | any;
    handler: (params: any) => Promise<any>;
}

export interface IAIActionRegistry {
    register(action: AIAction): void;
    get(name: string): AIAction | undefined;
    execute(name: string, params: any): Promise<any>;
    getTools(): AIAction[];
}

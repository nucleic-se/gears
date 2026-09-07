import { codingToolRuntime, codingToolEffect } from '@nucleic-se/agentic/harness';
import type { HarnessTool } from './tools.js';
import type { IValidatedToolRuntime } from '@nucleic-se/agentic/tool-runtime';

/** Adapt Agentic's validated coding pack to the queued host's effect boundary. */
export function codingTools(workspace: string, outputDirectory: string, readOnly = false): HarnessTool[] {
    const runtime = codingToolRuntime(workspace, { outputDirectory, readOnly });
    return runtimeTools(runtime, name => codingToolEffect(name)!);
}

/** Keep host-owned effect declarations separate from shared tool behavior. */
export function runtimeTools(runtime: IValidatedToolRuntime, effect: (name: string) => 'read' | 'write'): HarnessTool[] {
    return runtime.tools().map(definition => ({
        definition,
        effect: effect(definition.name),
        validate(args) {
            const checked = runtime.validate(definition.name, args);
            if (!checked.ok) throw new Error(checked.result.content);
            return checked.args;
        },
        execute: (args, signal, context) => runtime.call(definition.name, args, { ...context, signal, authorizedArgs: args }),
    }));
}

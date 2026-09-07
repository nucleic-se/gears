import { codingToolRuntime, codingToolEffect } from '@nucleic-se/agentic/harness';
import type { HarnessTool } from './tools.js';

/** Adapt Agentic's validated coding pack to the queued host's effect boundary. */
export function codingTools(workspace: string, outputDirectory: string, readOnly = false): HarnessTool[] {
    const runtime = codingToolRuntime(workspace, { outputDirectory, readOnly });
    return runtime.tools().map(definition => ({
        definition,
        effect: codingToolEffect(definition.name)!,
        validate(args) {
            const checked = runtime.validate(definition.name, args);
            if (!checked.ok) throw new Error(checked.result.content);
            return checked.args;
        },
        execute: (args, signal) => runtime.call(definition.name, args, { signal, authorizedArgs: args }),
    }));
}

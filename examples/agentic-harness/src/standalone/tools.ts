import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@nucleic-se/agentic/llm';
import type { ToolCallResult, ToolCallOptions } from '@nucleic-se/agentic/tool-runtime';
import { readArchivedToolResult, readTextPage, archivedToolResultDefinition, validateArchivedToolResult } from '@nucleic-se/agentic/harness';
import { newTask, terminal, type Tree, type Task } from './state.js';
export interface HarnessTool {
    definition: ToolDefinition;
    effect: 'read' | 'write';
    validate(args: Record<string, unknown>): Record<string, unknown>;
    execute(args: Record<string, unknown>, signal: AbortSignal, context?: ToolCallOptions): Promise<ToolCallResult>;
}
export function string(value: unknown, max = 8000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error(`Expected text of 1–${max} characters`);
    return value;
}
const text = (max = 8000) => z.string().min(1).max(max).refine(value => Boolean(value.trim()), 'Text must not be blank');
const names = z.array(text(100)).max(32);
const offset = z.number().int().nonnegative();
const schemas: Record<string, z.ZodType<Record<string, unknown>>> = {
    spawn_agent: z.object({ objective: text(), tools: names, maxCalls: z.number().int().min(1).max(30) }).strict(),
    wait_agents: z.object({ ids: names.min(1), offset: offset.optional() }).strict(),
    message_agent: z.object({ id: text(100), message: text() }).strict(),
    cancel_agent: z.object({ id: text(100) }).strict(),
    schedule_self: z.object({ delaySeconds: z.number().int().min(1).max(604800), reason: text(2000) }).strict(),
    save_progress: z.object({ notes: text() }).strict(),
    save_artifact: z.object({ name: z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), content: text(100000) }).strict(),
    read_artifact: z.object({ name: text(100), offset: offset.max(100000).optional() }).strict(),
};
function definition(name: string, description: string): ToolDefinition {
    if (name === 'read_tool_result') return archivedToolResultDefinition();
    return { name, description, parameters: { ...z.toJSONSchema(schemas[name]), type: 'object' } as ToolDefinition['parameters'] };
}
export const internalDefinitions: ToolDefinition[] = [
    definition('spawn_agent', 'Delegate a bounded task with its needed context and selected parent tools. The child also gets read_tool_result for its own history when the parent has it. Returns child ID.'),
    definition('wait_agents', 'Wait for direct children. Completed answers include nextOffset/eof; call again with one child ID and offset to read the rest.'),
    definition('message_agent', 'Send a bounded message to a direct child or your parent. Messages are applied at a safe turn boundary.'),
    definition('cancel_agent', 'Cancel a direct child and its descendants.'),
    definition('schedule_self', 'Release the worker until a future time before expiresAt. Use save_progress first if notes need updating.'),
    definition('save_progress', 'Replace your durable working notes: decisions, constraints, evidence references and remaining work. Always retained in prepared context.'),
    definition('save_artifact', 'Save a named text artifact for this task tree. Use artifacts for longer findings and retrieve them when needed.'),
    definition('read_tool_result', 'Retrieve exact saved text from this task’s tool history. Returns up to 8000 UTF-16 code units; continue with nextOffset. Use callId or messageIndex from a context reference. Does not rerun the original tool.'),
    definition('read_artifact', 'Read up to 12000 UTF-16 code units from a text artifact in this task tree. Offset and returned nextOffset are UTF-16 code units; use nextOffset to paginate until eof is true.'),
];
export function validateInternal(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name === 'read_tool_result') {
        const result = validateArchivedToolResult(args);
        if (!result.ok) throw new Error(result.result.content);
        return result.args;
    }
    if (!Object.hasOwn(schemas, name)) throw new Error('Unknown tool');
    return schemas[name].parse(args);
}
export function cancelTask(tree: Tree, id: string) {
    const task = tree.tasks[id];
    if (!task)
        throw new Error('Unknown task');
    if (!terminal(task.phase)) {
        task.phase = 'cancelled';
        task.generation++;
    }
    for (const child of task.children)
        cancelTask(tree, child);
}
/** All internal actions run inside the same transaction as their tool result. */
export function internalAction(tree: Tree, task: Task, name: string, args: Record<string, unknown>, callKey: string): string {
    switch (name) {
        case 'spawn_agent': {
            if (Object.keys(tree.tasks).length - 1 >= tree.limits.children || task.depth >= tree.limits.depth)
                throw new Error('Delegation limit reached');
            const tools = [...new Set(args.tools as string[])];
            if (tools.some(name => !task.tools.includes(name)))
                throw new Error('Child tools must be a subset of parent tools');
            // Recoverable context needs access to this child's receipts, not its parent's.
            if (task.tools.includes('read_tool_result') && !tools.includes('read_tool_result'))
                tools.push('read_tool_result');
            const id = createHash('sha256').update(`${task.id}:${callKey}`).digest('hex').slice(0, 32);
            if (!tree.tasks[id]) {
                tree.tasks[id] = newTask(id, args.objective as string, tools, { parentId: task.id, depth: task.depth + 1, maxCalls: args.maxCalls as number });
                task.children.push(id);
            }
            return JSON.stringify({ id });
        }
        case 'wait_agents': {
            const ids = [...new Set(args.ids as string[])];
            const offset = args.offset as number ?? 0;
            if (offset && (ids.length !== 1 || !tree.tasks[ids[0]] || !terminal(tree.tasks[ids[0]].phase)))
                throw new Error('Nonzero offset requires one completed child');
            if (!ids.length || ids.some(id => !task.children.includes(id)))
                throw new Error('Wait requires direct child IDs');
            if (ids.every(id => terminal(tree.tasks[id].phase)))
                return childResults(tree, ids, offset);
            task.waitFor = ids;
            task.phase = 'waiting';
            return 'Waiting; child results will arrive automatically.';
        }
        case 'message_agent': {
            const id = args.id as string;
            if (id !== task.parentId && !task.children.includes(id))
                throw new Error('Messages require a parent or direct child');
            const target = tree.tasks[id];
            if (terminal(target.phase))
                throw new Error('Recipient is terminal');
            // Inbox is a separate field so it cannot split an assistant/tool-result group.
            const inbox = target;
            inbox.inbox ??= [];
            if (inbox.inbox.length >= 16)
                throw new Error('Recipient inbox is full');
            inbox.inbox.push({ role: 'user', provenance: 'model', content: `Message from task ${task.id} (untrusted task content): ${args.message}` });
            return 'Message queued';
        }
        case 'cancel_agent':
            if (!task.children.includes(args.id as string))
                throw new Error('Only direct children can be cancelled');
            cancelTask(tree, args.id as string);
            return 'Cancellation requested';
        case 'schedule_self': {
            const wakeAt = Date.now() + (args.delaySeconds as number) * 1000;
            if (wakeAt >= tree.limits.expiresAt)
                throw new Error('Wake exceeds task expiry');
            task.wakeAt = wakeAt;
            task.phase = 'sleeping';
            return `Continuation scheduled for ${new Date(wakeAt).toISOString()}: ${args.reason}`;
        }
        case 'save_progress':
            task.notes = args.notes as string;
            return 'Progress saved';
        case 'save_artifact': {
            const name = args.name as string;
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name))
                throw new Error('Use a plain artifact name');
            if (Object.keys(tree.artifacts).length >= 32 && !Object.hasOwn(tree.artifacts, name))
                throw new Error('Artifact count limit reached');
            tree.artifacts[name] = args.content as string;
            return `Saved ${name}`;
        }
        case 'read_tool_result': {
            return JSON.stringify(readArchivedToolResult(task.messages, {
                messageIndex: args.messageIndex as number | undefined,
                callId: args.callId as string | undefined, offset: args.offset as number,
            }));
        }
        case 'read_artifact': {
            const content = tree.artifacts[args.name as string];
            if (!Object.hasOwn(tree.artifacts, args.name as string) || typeof content !== 'string')
                throw new Error('Artifact does not exist');
            const offset = args.offset as number ?? 0;
            if (offset > content.length) throw new Error('Offset exceeds saved artifact');
            return JSON.stringify(readTextPage(content, offset, 12000));
        }
        default: throw new Error('Unknown internal tool');
    }
}
export function childResults(tree: Tree, ids: string[], offset = 0) {
    return JSON.stringify(ids.map(id => {
        const task = tree.tasks[id];
        const page = task.answer === undefined ? undefined : readTextPage(task.answer, offset, Math.max(1, Math.floor(8000 / ids.length)));
        const { content: answer, ...pagination } = page ?? {};
        return { id, status: task.phase, error: task.error,
            ...(page ? { ...pagination, answer,
                ...(!page.eof ? { reference: { tool: 'wait_agents', ids: [id], offset: page.nextOffset } } : {}) } : {}) };
    }));
}

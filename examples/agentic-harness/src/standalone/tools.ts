import { createHash } from 'node:crypto';
import { realpath, opendir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { ToolDefinition } from '@nucleic-se/agentic/llm';
import type { ToolCallResult } from '@nucleic-se/agentic/tool-runtime';
import { newTask, terminal, type Tree, type Task } from './state.js';
export interface HarnessTool {
    definition: ToolDefinition;
    effect: 'read' | 'write';
    validate(args: Record<string, unknown>): Record<string, unknown>;
    execute(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolCallResult>;
}
export function string(value: unknown, max = 8000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error(`Expected text of 1–${max} characters`);
    return value;
}
function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`Expected integer ${min}–${max}`);
    return value;
}
const text = { type: 'string' };
const array = { type: 'array', items: text };
function definition(name: string, description: string, properties: NonNullable<ToolDefinition['parameters']['properties']>, required = Object.keys(properties)): ToolDefinition {
    return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}
export const internalDefinitions: ToolDefinition[] = [
    definition('spawn_agent', 'Delegate a bounded task. Supply all relevant context in the objective; child gets its own session and a subset of your tools. Returns child ID.', { objective: text, tools: array, maxCalls: { type: 'integer' } }),
    definition('wait_agents', 'Yield this worker until selected direct children finish. Their results return automatically. Do not poll.', { ids: array }),
    definition('message_agent', 'Send a bounded message to a direct child or your parent. Messages are applied at a safe turn boundary.', { id: text, message: text }),
    definition('cancel_agent', 'Cancel a direct child and its descendants.', { id: text }),
    definition('schedule_self', 'Save progress and release the worker until a future time. On wake, continue this same task. Bounded by the task expiry and shared budget.', { delaySeconds: { type: 'integer' }, reason: text }),
    definition('save_progress', 'Replace your durable working notes: decisions, constraints, evidence references and remaining work. Always retained in prepared context.', { notes: text }),
    definition('save_artifact', 'Save a named text artifact for this task tree. Use artifacts for longer findings and retrieve them when needed.', { name: text, content: text }),
    definition('read_tool_result', 'Retrieve exact saved text from this task’s tool history. Returns up to 8000 UTF-16 code units; continue with nextOffset. Use messageIndex from a context reference. Does not rerun the original tool.', { messageIndex: { type: 'integer' }, offset: { type: 'integer' } }, ['messageIndex']),
    definition('read_artifact', 'Read up to 12000 UTF-16 code units from a text artifact in this task tree. Offset and returned nextOffset are UTF-16 code units; use nextOffset to paginate until eof is true.', { name: text, offset: { type: 'integer' } }, ['name']),
];
export function validateInternal(name: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (name) {
        case 'spawn_agent': return { objective: string(args.objective), tools: strings(args.tools), maxCalls: integer(args.maxCalls, 1, 30) };
        case 'wait_agents': return { ids: strings(args.ids) };
        case 'message_agent': return { id: string(args.id, 100), message: string(args.message) };
        case 'cancel_agent': return { id: string(args.id, 100) };
        case 'schedule_self': return { delaySeconds: integer(args.delaySeconds, 1, 604800), reason: string(args.reason, 2000) };
        case 'save_progress': return { notes: string(args.notes, 8000) };
        case 'save_artifact': return { name: string(args.name, 100), content: string(args.content, 100000) };
        case 'read_tool_result': return { messageIndex: integer(args.messageIndex, 0, Number.MAX_SAFE_INTEGER), offset: args.offset === undefined ? 0 : integer(args.offset, 0, Number.MAX_SAFE_INTEGER) };
        case 'read_artifact': return { name: string(args.name, 100), offset: args.offset === undefined ? 0 : integer(args.offset, 0, 100000) };
        default: throw new Error('Unknown tool');
    }
}
function strings(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 32)
        throw new Error('Expected at most 32 strings');
    return [...new Set(value.map(v => string(v, 100)))];
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
            const tools = args.tools as string[];
            if (tools.some(name => !task.tools.includes(name)))
                throw new Error('Child tools must be a subset of parent tools');
            const id = createHash('sha256').update(`${task.id}:${callKey}`).digest('hex').slice(0, 32);
            if (!tree.tasks[id]) {
                tree.tasks[id] = newTask(id, args.objective as string, tools, { parentId: task.id, depth: task.depth + 1, maxCalls: args.maxCalls as number });
                task.children.push(id);
            }
            return JSON.stringify({ id });
        }
        case 'wait_agents': {
            const ids = args.ids as string[];
            if (!ids.length || ids.some(id => !task.children.includes(id)))
                throw new Error('Wait requires direct child IDs');
            if (ids.every(id => terminal(tree.tasks[id].phase)))
                return childResults(tree, ids);
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
            const inbox = (target as Task & {
                inbox?: string[];
            });
            inbox.inbox ??= [];
            if (inbox.inbox.length >= 16)
                throw new Error('Recipient inbox is full');
            inbox.inbox.push(`Message from task ${task.id} (untrusted task content): ${args.message}`);
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
            const messageIndex = args.messageIndex as number, offset = args.offset as number;
            const source = task.messages[messageIndex];
            if (!source || source.role !== 'tool_result') throw new Error('Saved tool result does not exist in this task');
            if (offset > source.content.length) throw new Error('Offset exceeds saved result');
            const content = source.content.slice(offset, offset + 8000), nextOffset = offset + content.length;
            return JSON.stringify({ messageIndex, toolName: source.toolName, totalCharacters: source.content.length,
                offset, nextOffset, eof: nextOffset === source.content.length, content });
        }
        case 'read_artifact': {
            const content = tree.artifacts[args.name as string];
            if (!Object.hasOwn(tree.artifacts, args.name as string) || typeof content !== 'string')
                throw new Error('Artifact does not exist');
            const offset = args.offset as number;
            if (offset > content.length) throw new Error('Offset exceeds saved artifact');
            const slice = content.slice(offset, offset + 12000), nextOffset = offset + slice.length;
            return JSON.stringify({ totalCharacters: content.length, offset, nextOffset, eof: nextOffset === content.length, content: slice });
        }
        default: throw new Error('Unknown internal tool');
    }
}
export function childResults(tree: Tree, ids: string[]) {
    return JSON.stringify(ids.map(id => ({ id, status: tree.tasks[id].phase, answer: tree.tasks[id].answer?.slice(0, 12000), error: tree.tasks[id].error })));
}
/** Read-only workspace extension. Realpath confinement is not an OS sandbox against hostile filesystem races. */
export async function workspaceTools(directory: string): Promise<HarnessTool[]> {
    const root = await realpath(directory);
    async function confined(path: string) {
        const actual = await realpath(resolve(root, path)), rel = relative(root, actual);
        if ((rel === '..' || rel.startsWith('..' + sep)) || isAbsolute(rel))
            throw new Error('Path escapes workspace');
        return actual;
    }
    return [
        { effect: 'read', definition: definition('list_files', 'List up to 200 entries in a workspace directory.', { path: text }),
            validate: args => ({ path: string(args.path, 1000) }),
            async execute(args, signal) {
                const entries: Array<{
                    name: string;
                    directory: boolean;
                }> = [];
                const directory = await opendir(await confined(args.path as string));
                let truncated = false;
                for await (const entry of directory) {
                    signal.throwIfAborted();
                    if (entries.length === 200) {
                        truncated = true;
                        break;
                    }
                    entries.push({ name: entry.name, directory: entry.isDirectory() });
                }
                return { ok: true, content: JSON.stringify({ entries, truncated }) };
            } },
        { effect: 'read', definition: definition('read_file', 'Read a bounded UTF-8 slice. Offset and limit are bytes; limit defaults to 16000 (maximum). Request smaller slices for focused verification. Use returned nextOffset to continue. Rejects invalid UTF-8.', { path: text, offset: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, ['path']),
            validate: args => ({ path: string(args.path, 1000), offset: args.offset === undefined ? 0 : integer(args.offset, 0, 100000000), limit: args.limit === undefined ? 16000 : integer(args.limit, 1, 16000) }),
            async execute(args, signal) {
                signal.throwIfAborted();
                const file = await open(await confined(args.path as string), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
                try {
                    const stat = await file.stat();
                    if (!stat.isFile())
                        throw new Error('Not a regular file');
                    signal.throwIfAborted();
                    const buffer = Buffer.alloc(args.limit === undefined ? 16000 : integer(args.limit, 1, 16000)), read = await file.read(buffer, 0, buffer.length, args.offset as number);
                    signal.throwIfAborted();
                    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
                    let content: string;
                    try {
                        // Buffer only a valid partial character at a chunk boundary, never invalid bytes at EOF.
                        const more = (args.offset as number) + read.bytesRead < stat.size;
                        content = decoder.decode(buffer.subarray(0, read.bytesRead), { stream: more });
                    } catch {
                        throw new Error('File is not UTF-8 or offset splits a character');
                    }
                    const consumed = Buffer.byteLength(content, 'utf8');
                    if (read.bytesRead > 0 && consumed === 0) throw new Error('Read limit cannot fit the next UTF-8 character; increase limit');
                    const nextOffset = (args.offset as number) + consumed;
                    return { ok: true, content: JSON.stringify({ bytes: stat.size, offset: args.offset, bytesRead: consumed, nextOffset, eof: nextOffset >= stat.size, content }) };
                }
                finally {
                    await file.close();
                }
            } },
    ];
}

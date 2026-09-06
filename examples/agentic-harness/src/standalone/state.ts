import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Message, ToolCall, TokenUsage } from '@nucleic-se/agentic/llm';
import type { ExecutionJournal } from '@nucleic-se/agentic/execution';
export type Phase = 'ready' | 'model' | 'tools' | 'external' | 'waiting' | 'sleeping' | 'completed' | 'failed' | 'unknown' | 'cancelled';
export interface Task {
    id: string;
    parentId?: string;
    title: string;
    objective: string;
    phase: Phase;
    messages: Message[];
    inbox?: string[];
    pending: ToolCall[];
    notes: string;
    children: string[];
    tools: string[];
    depth: number;
    calls: number;
    maxCalls: number;
    generation: number;
    operationId?: string;
    reservation?: number;
    wakeAt?: number;
    waitFor?: string[];
    answer?: string;
    error?: string;
}
export interface Limits {
    modelCalls: number;
    tokens: number;
    children: number;
    depth: number;
    expiresAt: number;
}
export interface Tree {
    id: string;
    revision: number;
    ownerEpoch: string;
    createdAt: number;
    updatedAt: number;
    tasks: Record<string, Task>;
    limits: Limits;
    chargedTokens: number;
    modelCalls: number;
    usage: TokenUsage;
    artifacts: Record<string, string>;
    composition: string;
}
export interface TreeEvent {
    sequence: number;
    type: string;
    taskId?: string;
    at: number;
    data?: unknown;
}
export interface HarnessDatabase {
    harness_trees: {
        id: string;
        revision: number;
        state: string;
        active: number;
    };
    harness_events: {
        tree_id: string;
        sequence: number;
        event: string;
    };
}
export const terminal = (phase: Phase) => ['completed', 'failed', 'unknown', 'cancelled'].includes(phase);
export function newTask(id: string, objective: string, tools: string[], options: Partial<Task> = {}): Task {
    return { id, title: objective.slice(0, 80), objective, phase: 'ready', messages: [{ role: 'user', content: objective, sticky: true }],
        pending: [], notes: '', children: [], tools, depth: 0, calls: 0, maxCalls: 30, generation: 0, ...options };
}
export class Conflict extends Error {
}
/** A bounded task tree is one transaction boundary: child creation and shared budgets cannot split. */
export class TreeStore implements ExecutionJournal<Tree, TreeEvent> {
    readonly epoch = randomUUID();
    constructor(private db: Kysely<HarnessDatabase>) { }
    async initialize() {
        await this.db.schema.createTable('harness_trees').ifNotExists().addColumn('id', 'text', c => c.primaryKey())
            .addColumn('revision', 'integer', c => c.notNull()).addColumn('state', 'text', c => c.notNull()).addColumn('active', 'integer', c => c.notNull().defaultTo(1)).execute();
        const table = (await this.db.introspection.getTables()).find(t => t.name === 'harness_trees')!;
        if (!table.columns.some(c => c.name === 'active'))
            await this.db.schema.alterTable('harness_trees').addColumn('active', 'integer', c => c.notNull().defaultTo(1)).execute();
        await this.db.schema.createIndex('harness_active').ifNotExists().on('harness_trees').column('active').execute();
        await this.db.schema.createTable('harness_events').ifNotExists().addColumn('tree_id', 'text', c => c.notNull())
            .addColumn('sequence', 'integer', c => c.notNull()).addColumn('event', 'text', c => c.notNull())
            .addPrimaryKeyConstraint('harness_event_pk', ['tree_id', 'sequence']).execute();
    }
    async create(objective: string, tools: string[], composition: string, limits: Partial<Limits> = {}) {
        if (!objective.trim() || objective.length > 32000)
            throw new Error('Objective must contain 1–32000 characters');
        const id = randomUUID(), now = Date.now();
        const resolved = { modelCalls: 60, tokens: 200000, children: 8, depth: 2, expiresAt: now + 86400000, ...limits };
        for (const value of Object.values(resolved))
            if (!Number.isSafeInteger(value) || value < 1)
                throw new Error('Limits must be positive integers');
        if (resolved.children > 32 || resolved.depth > 5 || resolved.modelCalls > 1000 || resolved.expiresAt <= now)
            throw new Error('Limits exceed supported bounds');
        const tree: Tree = { id, revision: 0, ownerEpoch: this.epoch, createdAt: now, updatedAt: now, tasks: { [id]: newTask(id, objective, tools) },
            limits: resolved, chargedTokens: 0, modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, artifacts: {}, composition };
        await this.db.insertInto('harness_trees').values({ id, revision: 0, state: JSON.stringify(tree), active: 1 }).execute();
        return tree;
    }
    async get(id: string): Promise<Tree | undefined> {
        const row = await this.db.selectFrom('harness_trees').select('state').where('id', '=', id).executeTakeFirst();
        return row ? JSON.parse(row.state) : undefined;
    }
    async list(activeOnly = false, page?: {
        limit: number;
        offset: number;
    }): Promise<Tree[]> {
        let query = this.db.selectFrom('harness_trees').select('state');
        if (activeOnly)
            query = query.where('active', '=', 1);
        if (page)
            query = query.orderBy(sql<number> `json_extract(state, '$.createdAt')`, 'desc').orderBy('id', 'desc').limit(page.limit).offset(page.offset);
        return (await query.execute()).map(row => JSON.parse(row.state));
    }
    async commit(id: string, expected: number, state: Tree, event: TreeEvent) {
        if (state.id !== id || state.revision !== expected + 1 || event.sequence !== state.revision)
            throw new Error('Invalid transition');
        const serialized = JSON.stringify(state), serializedEvent = JSON.stringify(event);
        await this.db.transaction().execute(async (tx) => {
            const result = await tx.updateTable('harness_trees').set({ revision: state.revision, state: serialized, active: Object.values(state.tasks).some(t => !terminal(t.phase)) ? 1 : 0 }).where('id', '=', id).where('revision', '=', expected).executeTakeFirst();
            if (result.numUpdatedRows !== 1n)
                throw new Conflict('Stale tree revision');
            await tx.insertInto('harness_events').values({ tree_id: id, sequence: event.sequence, event: serializedEvent }).execute();
        });
    }
    /** Retry pure state changes only. Model and external tool calls must stay outside this callback. */
    async change(id: string, type: string, update: (tree: Tree) => void, taskId?: string, data?: unknown): Promise<Tree> {
        for (let attempt = 0; attempt < 100; attempt++) {
            const tree = await this.get(id);
            if (!tree)
                throw new Error('Unknown task tree');
            if (tree.ownerEpoch !== this.epoch)
                throw new Error('Tree ownership lost');
            const expected = tree.revision;
            update(tree);
            tree.revision++;
            tree.updatedAt = Date.now();
            try {
                await this.commit(id, expected, tree, { sequence: tree.revision, type, taskId, data, at: tree.updatedAt });
                return tree;
            }
            catch (error) {
                if (!(error instanceof Conflict))
                    throw error;
            }
        }
        throw new Conflict('Tree remained busy');
    }
    /** Called only after acquiring the Gears host lease. Revision fencing rejects old-owner writes. */
    async claim(snapshot: Tree) {
        const tree = structuredClone(snapshot), id = tree.id;
        const expected = tree.revision;
        tree.ownerEpoch = this.epoch;
        tree.revision++;
        await this.commit(id, expected, tree, { sequence: tree.revision, type: 'host.claimed', at: Date.now() });
    }
    async events(id: string, after = 0): Promise<TreeEvent[]> {
        return (await this.db.selectFrom('harness_events').select('event').where('tree_id', '=', id).where('sequence', '>', after)
            .orderBy('sequence').limit(200).execute()).map(row => JSON.parse(row.event));
    }
}

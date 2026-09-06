import type { Kysely } from 'kysely';
import type { ExecutionJournal, ModelOutcome } from '@nucleic-se/agentic/execution';
import type { TurnResponse } from '@nucleic-se/agentic/llm';

export interface WorkState {
    id: string;
    revision: number;
    prompt: string;
    status: 'ready' | 'intent' | 'completed' | 'failed' | 'unknown';
    operationId?: string;
    response?: TurnResponse;
    receipt?: ModelOutcome<TurnResponse>;
}
export interface WorkEvent { workId: string; sequence: number; type: string; data?: unknown }
interface WorkRow { id: string; revision: number; state: string }
interface EventRow { work_id: string; sequence: number; event: string }
export interface AgentDatabase { agent_work: WorkRow; agent_events: EventRow }

/** Application-owned adapter over the database connection supplied by Gears. */
export class WorkJournal implements ExecutionJournal<WorkState, WorkEvent> {
    constructor(private readonly db: Kysely<AgentDatabase>) {}
    async initialize() {
        await this.db.schema.createTable('agent_work').ifNotExists()
            .addColumn('id', 'text', c => c.primaryKey()).addColumn('revision', 'integer', c => c.notNull())
            .addColumn('state', 'text', c => c.notNull()).execute();
        await this.db.schema.createTable('agent_events').ifNotExists()
            .addColumn('work_id', 'text', c => c.notNull()).addColumn('sequence', 'integer', c => c.notNull())
            .addColumn('event', 'text', c => c.notNull()).addPrimaryKeyConstraint('agent_event_pk', ['work_id', 'sequence']).execute();
    }
    async create(id: string, prompt: string) {
        const state: WorkState = { id, prompt, revision: 0, status: 'ready' };
        await this.db.insertInto('agent_work').values({ id, revision: 0, state: JSON.stringify(state) }).onConflict(c => c.column('id').doNothing()).execute();
        const stored = (await this.get(id))!;
        if (stored.prompt !== prompt) throw new Error('Work identity was reused with a different prompt');
        return stored;
    }
    async get(id: string): Promise<WorkState | undefined> {
        const row = await this.db.selectFrom('agent_work').select('state').where('id', '=', id).executeTakeFirst();
        return row ? JSON.parse(row.state) as WorkState : undefined;
    }
    async commit(id: string, expectedRevision: number, state: WorkState, event: WorkEvent): Promise<void> {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || state.id !== id || state.revision !== expectedRevision + 1 || event.workId !== id || event.sequence !== state.revision) throw new Error('Invalid journal transition');
        const serialized = JSON.stringify(state), receipt = JSON.stringify(event);
        await this.db.transaction().execute(async transaction => {
            const changed = await transaction.updateTable('agent_work').set({ revision: state.revision, state: serialized })
                .where('id', '=', id).where('revision', '=', expectedRevision).executeTakeFirst();
            if (changed.numUpdatedRows !== 1n) throw new Error('Journal revision conflict');
            await transaction.insertInto('agent_events').values({ work_id: id, sequence: event.sequence, event: receipt }).execute();
        });
    }
    async events(id: string): Promise<WorkEvent[]> {
        return (await this.db.selectFrom('agent_events').select('event').where('work_id', '=', id).orderBy('sequence').execute())
            .map(row => JSON.parse(row.event) as WorkEvent);
    }
}

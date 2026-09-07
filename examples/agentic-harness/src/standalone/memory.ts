import { memoryToolRuntime, type NoteStore } from '@nucleic-se/agentic/harness';
import type { StandaloneHarness } from './host.js';
import { runtimeTools } from './coding.js';

/** Gears owns source lookup; Agentic owns note capture, versioning and recall. */
export function memoryTools(store: NoteStore, host: () => StandaloneHarness) {
    return runtimeTools(memoryToolRuntime(store, async (sessionId, callId, signal) => {
        signal?.throwIfAborted();
        const [treeId, taskId, extra] = sessionId.split('/');
        if (!treeId || !taskId || extra) throw new Error('Invalid source session');
        const tree = await host().store.get(treeId), task = tree?.tasks[taskId];
        if (!task) throw new Error('Source task not found');
        const matches = task.messages.map((message, index) => ({ message, index }))
            .filter(({ message }) => message.role === 'tool_result' && message.toolCallId === callId);
        if (matches.length !== 1) throw new Error('Source call is missing or ambiguous');
        const { message, index } = matches[0];
        if (message.role !== 'tool_result') throw new Error('Source is not a tool receipt');
        if (task.activeTool?.id === callId) throw new Error('Source operation is unresolved');
        return { reference: `tree/${treeId}/task/${taskId}/message/${index}`, content: message.content, isError: message.isError ?? false };
    }), name => name === 'memory_save' ? 'write' : 'read');
}

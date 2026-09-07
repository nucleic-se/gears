import { memoryToolRuntime, type NoteStore } from '@nucleic-se/agentic/harness';
import type { StandaloneHarness } from './host.js';
import { runtimeTools } from './coding.js';

/** Gears owns source lookup; Agentic owns note capture, versioning and recall. */
export function memoryTools(store: NoteStore, host: () => StandaloneHarness) {
    return runtimeTools(memoryToolRuntime(store, async (query, signal) => {
        signal?.throwIfAborted();
        const reference = 'reference' in query ? /^tree\/([^/]+)\/task\/([^/]+)\/(message|resolution)\/(\d+)$/.exec(query.reference) : undefined;
        if ('reference' in query && !reference) throw new Error('Invalid task source reference');
        const [treeId, taskId, extra] = 'sessionId' in query ? query.sessionId.split('/') : [reference![1], reference![2]];
        if (!treeId || !taskId || extra) throw new Error('Invalid source session');
        const tree = await host().store.get(treeId), task = tree?.tasks[taskId];
        if (!task) throw new Error('Source task not found');
        const matches = task.messages.map((message, index) => ({ message, index }))
            .filter(({ message, index }) => message.role === 'tool_result' &&
                ('callId' in query ? message.toolCallId === query.callId : index === Number(reference![4])));
        if (matches.length !== 1) throw new Error('Source call is missing or ambiguous');
        const { message, index } = matches[0];
        if (message.role !== 'tool_result') throw new Error('Source is not a tool receipt');
        if (task.activeTool?.id === message.toolCallId) throw new Error('Source operation is unresolved');
        const resolution = task.resolutions?.[index];
        if (reference?.[3] === 'resolution' && !resolution) throw new Error('Source resolution not found');
        if (resolution && ('callId' in query || reference?.[3] === 'resolution'))
            return { reference: `tree/${treeId}/task/${taskId}/resolution/${index}`, content: resolution.result.content, isError: !resolution.result.ok };
        return { reference: `tree/${treeId}/task/${taskId}/message/${index}`, content: message.content, isError: message.isError ?? false };
    }), name => name === 'memory_save' ? 'write' : 'read');
}

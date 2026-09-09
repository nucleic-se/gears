import { expect } from 'vitest';
import type { Message } from '@nucleic-se/agentic/llm';

/** Assert the shared model-visible reference label before checking the unchanged source text. */
export function toolText(message: Message): string {
    if (message.role !== 'tool_result') throw new Error('Expected a tool result');
    const label = `${JSON.stringify({ toolCallId: message.toolCallId })}\n`;
    expect(message.role).toBe('tool_result');
    expect(message.content.startsWith(label)).toBe(true);
    return message.content.slice(label.length);
}

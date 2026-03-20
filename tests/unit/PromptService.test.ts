import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIPromptService } from '../../src/core/ai/PromptService.js';
import { Container } from '../../src/core/container/Container.js';


describe('AIPipeline', () => {
    let container: Container;
    let mockLlmProvider: any;
    let service: AIPromptService;

    beforeEach(() => {
        container = new Container();
        mockLlmProvider = {
            turn: vi.fn(),
            structured: vi.fn(),
            embed: vi.fn()
        };
        container.singleton('ILLMProvider', () => mockLlmProvider);

        service = new AIPromptService(container);
    });

    it('should execute a simple pipeline', async () => {
        const result = await service.pipeline('input')
            .pipe(val => val.toUpperCase())
            .run();

        expect(result).toBe('INPUT');
    });

    it('should execute chained llm calls', async () => {
        mockLlmProvider.turn
            .mockResolvedValueOnce({ message: { role: 'assistant', content: 'Summary of input' }, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } })
            .mockResolvedValueOnce({ message: { role: 'assistant', content: 'Spanish translation' }, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });

        const result = await service.pipeline('original text')
            .llm(builder => builder.system('Summarize'))
            .pipe(summary => summary + ' [verified]')
            .llm(builder => builder.system('Translate'))
            .run();

        expect(result).toBe('Spanish translation');

        expect(mockLlmProvider.turn).toHaveBeenNthCalledWith(1, expect.objectContaining({
            system: 'Summarize',
            messages: [{ role: 'user', content: 'original text' }]
        }));

        expect(mockLlmProvider.turn).toHaveBeenNthCalledWith(2, expect.objectContaining({
            system: 'Translate',
            messages: [{ role: 'user', content: 'Summary of input [verified]' }]
        }));
    });
    it('should retry failed steps', async () => {
        const error = new Error('Transient Error');
        mockLlmProvider.turn
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockResolvedValue({ message: { role: 'assistant', content: 'Success after retry' }, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });

        const result = await service.pipeline('input')
            .llm(b => b.system('Retry Test'), 'gpt-4', { retry: 3 })
            .run();

        expect(result).toBe('Success after retry');
        expect(mockLlmProvider.turn).toHaveBeenCalledTimes(3);
    });

    it('should catch errors globally', async () => {
        const error = new Error('Catastrophic Failure');
        mockLlmProvider.turn.mockRejectedValue(error);

        const result = await service.pipeline('input')
            .llm(b => b.system('Fail'))
            .catch(err => {
                expect(err).toBe(error);
                return 'Fallback Value';
            })
            .run();

        expect(result).toBe('Fallback Value');
    });
});

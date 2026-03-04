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
            process: vi.fn(),
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
        // Mock LLM responses
        mockLlmProvider.process
            .mockResolvedValueOnce({ response: 'Summary of input' }) // First LLM call
            .mockResolvedValueOnce({ response: 'Spanish translation' }); // Second LLM call

        const result = await service.pipeline('original text')
            .llm(builder => builder.system('Summarize'))
            .pipe(summary => summary + ' [verified]') // Intermediary sync step
            .llm(builder => builder.system('Translate'))
            .run();

        expect(result).toBe('Spanish translation');

        // Verify call 1
        expect(mockLlmProvider.process).toHaveBeenNthCalledWith(1, expect.objectContaining({
            instructions: 'Summarize',
            text: 'original text'
        }));

        // Verify call 2 (input should be the result of previous pipe)
        expect(mockLlmProvider.process).toHaveBeenNthCalledWith(2, expect.objectContaining({
            instructions: 'Translate',
            text: 'Summary of input [verified]'
        }));
    });
    it('should retry failed steps', async () => {
        const error = new Error('Transient Error');
        mockLlmProvider.process
            .mockRejectedValueOnce(error) // Fail 1
            .mockRejectedValueOnce(error) // Fail 2
            .mockResolvedValue({ response: 'Success after retry' }); // Success 3

        const result = await service.pipeline('input')
            .llm(b => b.system('Retry Test'), 'gpt-4', { retry: 3 })
            .run();

        expect(result).toBe('Success after retry');
        expect(mockLlmProvider.process).toHaveBeenCalledTimes(3);
    });

    it('should catch errors globally', async () => {
        const error = new Error('Catastrophic Failure');
        mockLlmProvider.process.mockRejectedValue(error);

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

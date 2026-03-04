import { describe, it, expect, vi } from 'vitest';
import { AIPipeline } from '../../src/core/ai/Pipeline.js';
import { IAIPromptService, IAIPromptBuilder } from '../../src/core/ai/interfaces.js';

describe('AIPipeline', () => {
    it('should auto-inject string input into llm prompt as user message', async () => {
        const mockRun = vi.fn().mockResolvedValue('response');
        const mockBuilder: IAIPromptBuilder = {
            system: vi.fn().mockReturnThis(),
            user: vi.fn().mockReturnThis(),
            run: mockRun
        } as any;

        const mockPromptService: IAIPromptService = {
            use: vi.fn().mockReturnValue(mockBuilder),
            pipeline: vi.fn()
        };

        const pipeline = new AIPipeline<string>(mockPromptService);

        const result = await pipeline
            .llm((builder) => {
                builder.system('system-instruction');
            })
            .run('user-input-text');

        expect(mockPromptService.use).toHaveBeenCalled();
        expect(mockBuilder.user).toHaveBeenCalledWith('user-input-text');
        expect(mockBuilder.system).toHaveBeenCalledWith('system-instruction');
        expect(mockRun).toHaveBeenCalled();
        expect(result).toBe('response');
    });

    it('should auto-inject object input into llm prompt as JSON string', async () => {
        const mockRun = vi.fn().mockResolvedValue('response');
        const mockBuilder: IAIPromptBuilder = {
            system: vi.fn().mockReturnThis(),
            user: vi.fn().mockReturnThis(),
            run: mockRun
        } as any;

        const mockPromptService: IAIPromptService = {
            use: vi.fn().mockReturnValue(mockBuilder),
            pipeline: vi.fn()
        };

        const pipeline = new AIPipeline<any>(mockPromptService);
        const inputObj = { key: 'value' };

        await pipeline
            .llm(() => { })
            .run(inputObj);

        expect(mockBuilder.user).toHaveBeenCalledWith(JSON.stringify(inputObj));
    });
});

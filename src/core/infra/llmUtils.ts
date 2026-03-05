/**
 * Shared utilities for LLM providers.
 */

/**
 * Normalise a JSON Schema for the Gemini responseSchema format.
 *
 * Gemini uses its own Schema type (not JSON Schema):
 *  - type must be a single string, not an array
 *  - null types are expressed as { type: 'number', nullable: true }
 *  - unsupported keywords (additionalProperties, $schema, $id) are stripped
 *
 * Recursively processes properties and items.
 */
export function toGeminiSchema(node: Record<string, unknown>): Record<string, unknown> {
    if (typeof node !== 'object' || node === null) return node;

    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(node)) {
        // Strip keywords Gemini doesn't understand.
        if (key === '$schema' || key === '$id' || key === 'additionalProperties') continue;

        if (key === 'type' && Array.isArray(value)) {
            // e.g. ['number', 'null'] → type: 'number', nullable: true
            const types = (value as string[]).filter(t => t !== 'null');
            if (types.length > 0) out['type'] = types[0];
            if ((value as string[]).includes('null')) out['nullable'] = true;
            continue;
        }

        if (key === 'properties' && typeof value === 'object' && value !== null) {
            out['properties'] = Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(([k, v]) => [
                    k,
                    toGeminiSchema(v as Record<string, unknown>),
                ]),
            );
            continue;
        }

        if (key === 'items' && typeof value === 'object' && value !== null) {
            out['items'] = toGeminiSchema(value as Record<string, unknown>);
            continue;
        }

        out[key] = value;
    }

    return out;
}

/**
 * Attempts to extract a JSON object or array from a string that may contain
 * surrounding text, markdown fences, or thinking tokens.
 */
export function extractJsonCandidate(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        return fenced[1].trim();
    }

    const startIndex = trimmed.search(/[\[{]/);
    if (startIndex === -1) return null;

    const startChar = trimmed[startIndex];
    const endChar = startChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') { inString = true; continue; }
        if (ch === startChar) depth += 1;
        if (ch === endChar) {
            depth -= 1;
            if (depth === 0) return trimmed.slice(startIndex, i + 1);
        }
    }

    return null;
}

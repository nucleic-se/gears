/**
 * Shared utilities for LLM providers.
 */

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

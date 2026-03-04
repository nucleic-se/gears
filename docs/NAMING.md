# Naming Conventions

This project uses consistent, explicit naming to reduce ambiguity and avoid collisions.

## Types
- `PascalCase` for classes, types, enums, and interfaces.
- Service-style interfaces usually use an `I` prefix (e.g. `ILogger`, `IStore`).
- Option/config/result shapes may omit `I` (e.g. `FetchOptions`, `FetchResponse`, `CommandDefinition`).
- Acronyms are all caps: `AI`, `LLM`, `SQL`, `HTTP`.

Examples:
- `CoreServiceProvider`, `IAIPromptService`, `ILLMProvider`, `CommandDefinition`.

## Files
- Class-centric files use the class name in `PascalCase` (e.g., `AIServiceProvider.ts`).
- Module/utility files are lowercase (e.g., `interfaces.ts`, `domain.ts`, `index.ts`).

## Folders
- Prefer lowercase for folders (e.g., `core`, `bundles`, `notes`).
- Keep existing legacy folder casing stable unless there is a specific refactor goal.

## Commands
- Use lowercase verbs; use hyphens for multiword commands.

## Keys and Namespaces
- Store and event keys use lowercase namespaced strings, usually `bundle:feature`.
- Job types may use dotted lowercase names (e.g., `memory.compact`).

## Bundle-Specific Interfaces
- Prefix with the bundle domain when the interface is not core/generic.
- Example: `INotificationService` (bundle-specific) vs core `IStore`.

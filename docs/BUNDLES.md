# Bundles

Bundles are the unit of extension in gears. A bundle provides services, CLI commands, and background behavior without modifying core.

## Bundle Interface

```typescript
interface Bundle {
    name: string;
    version: string;
    description?: string;
    requires?: string[];                                    // dependency names
    providers: Array<new (app: Container) => ServiceProvider>;
    commands?: CommandDefinition[];
    init?(app: Container): Promise<void>;                   // worker-only startup
    shutdown?(app: Container): Promise<void>;               // cleanup on unload
}
```

## Structure

```
src/bundles/my-bundle/
├── index.ts              # Bundle definition
├── MyServiceProvider.ts  # register() + boot()
└── MyService.ts          # Business logic
```

## Providers

Providers follow a strict two-phase contract:

- **`register()`** — Bind services to the container. No side effects. No resolving other services.
- **`boot()`** — Wire listeners, run migrations, resolve dependencies. Must remain lightweight.

```typescript
class MyServiceProvider extends ServiceProvider {
    register(): void {
        this.app.singleton('IMyService', () => new MyService());
    }

    async boot(): Promise<void> {
        const events = this.app.make<IEventBus>('IEventBus');
        events.on('item:created', this.handleCreated.bind(this));
    }
}
```

## Commands

Commands are defined as `CommandDefinition[]` and auto-registered by the CLI:

```typescript
commands: [{
    name: 'do-thing',
    description: 'Does the thing',
    args: '<input>',
    options: [{ flags: '-v, --verbose', description: 'Verbose output' }],
    preferredMode: 'silent', // optional: text | json | silent | tui
    action: async (args, app) => { ... }
}]
```

```bash
npx gears <bundle> <command>
```

## Init

`init()` is only called by the worker (`npx gears work`). CLI commands skip it. Use it for:
- Cron schedule registration
- Background loops
- Long-running setup

## Dependencies

Declare dependencies via `requires`:

```typescript
export const bundle: Bundle = {
    name: 'my-bundle',
    requires: ['database'],
    // ...
};
```

BundleManager will:
- Boot dependencies first (topological sort)
- Throw `MissingDependencyError` if a required bundle isn't loaded
- Throw `CircularDependencyError` on dependency cycles
- Reject reserved bundle names: `work`, `bundles`, `load`, `unload`
- Shutdown in reverse-dependency order

## Loading

```bash
npx gears load ./dist/src/bundles/my-bundle   # Load and persist to bundles.json
npx gears unload my-bundle                # Remove from config
npx gears bundles                         # List loaded bundles
```

The worker watches `bundles.json` and hot-reloads on changes.

## Built-in Bundles

| Bundle | Description | Requires |
|--------|-------------|----------|
| `database` | Kysely database provider | — |

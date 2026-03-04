export class MissingDependencyError extends Error {
    constructor(bundleName: string, missingDep: string) {
        super(`Bundle '${bundleName}' requires '${missingDep}', which is not loaded.`);
        this.name = 'MissingDependencyError';
    }
}

export class DependencyNotBootedError extends Error {
    constructor(bundleName: string, depName: string) {
        super(`Bundle '${bundleName}' requires '${depName}', which is loaded but not booted.`);
        this.name = 'DependencyNotBootedError';
    }
}

export class CircularDependencyError extends Error {
    constructor(path: string[]) {
        super(`Circular dependency detected: ${path.join(' -> ')}`);
        this.name = 'CircularDependencyError';
    }
}

/**
 * Base error class for all Gears framework errors.
 * Provides a structured way to handle errors with codes and metadata.
 */
export class GearsError extends Error {
    constructor(
        message: string,
        public code: string = 'GEARS_ERROR',
        public details?: Record<string, any>
    ) {
        super(message);
        this.name = this.constructor.name;
    }
}

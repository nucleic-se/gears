import type { Tree, Task } from './state.js';

export class AdmissionDeferred extends Error {
    constructor(readonly requiredTokens: number, readonly generation: number, readonly inboxSize: number) { super('Model admission awaits live reservations'); }
}

function liveReservations(tree: Tree) {
    // Cancellation requests an abort; the owned model receipt may still release capacity.
    // Recovery clears interrupted operation IDs before reconciliation.
    return Object.values(tree.tasks).filter(task => (task.phase === 'model' || task.phase === 'cancelled') && task.operationId && (task.reservation ?? 0) > 0);
}

/** Existing charges remain authoritative; only live reservations might release capacity. */
export function admissionWait(tree: Tree, requiredTokens: number): string[] | undefined {
    const available = Math.max(0, tree.limits.tokens - tree.chargedTokens);
    if (requiredTokens <= available) return undefined;
    const pending = liveReservations(tree);
    // Include overspent liabilities instead of clamping them away.
    if (requiredTokens <= tree.limits.tokens - tree.chargedTokens + pending.reduce((sum, task) => sum + task.reservation!, 0))
        return pending.map(task => task.operationId!);
    throw new Error(`Shared token budget exhausted: request needs ${requiredTokens}, remaining ${available}`);
}

export function admissionChanged(tree: Tree, task: Task): boolean {
    const wait = task.admissionWait;
    if (task.phase !== 'admission' || !wait) return false;
    const live = new Set(liveReservations(tree).map(task => task.operationId));
    return (task.inbox?.length ?? 0) !== wait.inboxSize || wait.operationIds.some(id => !live.has(id));
}

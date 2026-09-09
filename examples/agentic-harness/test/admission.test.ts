import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StandaloneHarness } from '../src/standalone/host.js';
import { admissionWait, preparationCapacity } from '../src/standalone/admission.js';
import type { Tree } from '../src/standalone/state.js';

const resources: { host: StandaloneHarness; path: string }[] = [];
afterEach(async () => { for (const {host,path} of resources.splice(0)) { await host.close(); await rm(path,{recursive:true,force:true}); } });
async function fixture() {
    const path = await mkdtemp(join(tmpdir(), 'admission-'));
    const turn = vi.fn(async () => ({ message: {role:'assistant' as const,content:'done'},stopReason:'end_turn' as const,usage:{inputTokens:100,outputTokens:20} }));
    const host = await StandaloneHarness.open({ contextTokens: 16000,dataDir:path,provider:{turn,structured:vi.fn()},rootTools:[]});
    resources.push({host,path});
    const tree = await host.store.create('Answer the question', [], host.compositionId, {tokens:5000});
    await host.store.change(tree.id,'fixture.pending',current => {
        current.tasks.pending = {...structuredClone(current.tasks[current.id]),id:'pending',parentId:current.id,phase:'model',operationId:'pending-model',reservation:4000,calls:1};
        current.tasks[current.id].children=['pending'];
        current.modelCalls=1; current.chargedTokens=4000;
    });
    const read = async () => (await host.store.get(tree.id))!;
    const phase = async (expected: string) => vi.waitFor(async () => expect((await read()).tasks[tree.id].phase).toBe(expected),{timeout:5000,interval:20});
    const settle = async (used: number | undefined) => host.store.change(tree.id,'fixture.settled',current => {
        const pending=current.tasks.pending;
        if(pending.phase!=='cancelled') pending.phase=used===undefined?'unknown':'completed';
        if(used!==undefined) current.chargedTokens+=used-pending.reservation!;
        pending.reservation=undefined;
    });
    return {host,turn,tree,read,phase,settle};
}

it('releases the worker without charging or dispatching, then admits exactly once after settlement',async()=>{
    const f=await fixture(); await f.host.reconcile(); await f.phase('admission');
    const waiting=await f.read();
    expect(f.turn).not.toHaveBeenCalled();
    expect(waiting.modelCalls).toBe(1); expect(waiting.chargedTokens).toBe(4000);
    expect(waiting.tasks[waiting.id].admissionWait?.operationIds).toEqual(['pending-model']);
    for(let i=0;i<3;i++)await f.host.reconcile();
    expect((await f.host.store.events(f.tree.id)).filter(e=>e.type==='model.deferred')).toHaveLength(1);
    await f.settle(500); await f.host.reconcile(); await f.phase('completed');
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect((await f.read()).chargedTokens).toBe(620);
    expect((await f.read()).tasks[f.tree.id].admissionWait).toBeUndefined();
    const intents = (await f.host.store.events(f.tree.id)).filter(e=>e.type==='model.intent');
    expect(intents).toHaveLength(1);
    expect(intents[0].data).toMatchObject({ context: { tokenBudget: 4500 } });
});

it.each([3900,undefined])('fails without dispatch when settlement leaves insufficient capacity (%s)',async used=>{
    const f=await fixture(); await f.host.reconcile(); await f.phase('admission');
    await f.settle(used); await f.host.reconcile(); await f.phase('failed');
    expect(f.turn).not.toHaveBeenCalled();
    expect((await f.read()).chargedTokens).toBe(used??4000);
    expect((await f.read()).tasks[f.tree.id].error).toContain('protected content cannot be dropped');
});

it('does not strand a waiter if a receipt settles between rejection and persistence',async()=>{
    const f=await fixture(); const change=f.host.store.change.bind(f.host.store);
    let intercepted=false;
    vi.spyOn(f.host.store,'change').mockImplementation(async (...args: Parameters<typeof change>)=>{
        if(args[1]==='model.deferred'&&!intercepted){intercepted=true;await f.settle(500);}
        return change(...args);
    });
    await f.host.reconcile(); await f.phase('completed');
    expect(intercepted).toBe(true); expect(f.turn).toHaveBeenCalledTimes(1);
});

it('reprepares after new input and cancels without ever dispatching blocked work',async()=>{
    const f=await fixture(); await f.host.reconcile(); await f.phase('admission');
    await f.host.send(f.tree.id,f.tree.id,'Updated requirement'); await f.host.reconcile();
    await vi.waitFor(async()=>expect((await f.read()).tasks[f.tree.id].admissionWait?.inboxSize).toBe(1));
    expect(f.turn).not.toHaveBeenCalled();
    await f.host.cancel(f.tree.id); await f.phase('cancelled');
    await f.settle(500); await f.host.reconcile();
    expect(f.turn).not.toHaveBeenCalled(); expect((await f.read()).tasks[f.tree.id].phase).toBe('cancelled');
});

it('does not treat unknown liabilities or impossible reservations as available capacity',()=>{
    const tree={limits:{tokens:100},chargedTokens:150,tasks:{one:{phase:'model',operationId:'one',reservation:40},two:{phase:'unknown',operationId:'two',reservation:100}}} as unknown as Tree;
    expect(()=>admissionWait(tree,10)).toThrow('Shared token budget exhausted');
    tree.tasks.one.reservation=70;
    expect(admissionWait(tree,10)).toEqual(['one']);
    expect(()=>admissionWait(tree,30)).toThrow('Shared token budget exhausted');
});

it('recovery wakes admission waits without refunding interrupted model liabilities',async()=>{
    const f=await fixture(); await f.host.reconcile(); await f.phase('admission');
    const resource=resources.find(r=>r.host===f.host)!;
    await f.host.close();
    const reopened=await StandaloneHarness.open({ contextTokens: 16000,dataDir:resource.path,provider:{turn:f.turn,structured:vi.fn()},rootTools:[]});
    resource.host=reopened;
    await vi.waitFor(async()=>expect((await reopened.store.get(f.tree.id))!.tasks[f.tree.id].phase).toBe('failed'));
    const recovered=(await reopened.store.get(f.tree.id))!;
    expect(recovered.tasks.pending.phase).toBe('unknown');
    expect(recovered.chargedTokens).toBe(4000); expect(f.turn).not.toHaveBeenCalled();
});

it('multiple waiters race through atomic admission rather than oversubscribing capacity',async()=>{
    const f=await fixture();
    let release!:()=>void;
    f.turn.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve({message:{role:'assistant',content:'done'},stopReason:'end_turn',usage:{inputTokens:2480,outputTokens:20}});}));
    await f.host.store.change(f.tree.id,'fixture.waiter',tree=>{
        tree.tasks.other={...structuredClone(tree.tasks[tree.id]),id:'other',children:[]};
    });
    await f.host.reconcile();
    await vi.waitFor(async()=>expect(['admission','admission']).toEqual([(await f.read()).tasks[f.tree.id].phase,(await f.read()).tasks.other.phase]));
    await f.settle(2000); await f.host.reconcile();
    await vi.waitFor(async()=>{
        expect(f.turn).toHaveBeenCalledTimes(1);
        const tree=await f.read();expect([tree.tasks[tree.id].phase,tree.tasks.other.phase].sort()).toEqual(['admission','model']);
    });
    release();
    await vi.waitFor(async()=>{
        const tree=await f.read();expect([tree.tasks[tree.id].phase,tree.tasks.other.phase].sort()).toEqual(['completed','failed']);
    });
    expect(f.turn).toHaveBeenCalledTimes(1);expect((await f.read()).chargedTokens).toBe(4500);
});

it('expiry cancels an admission wait without consuming a provider call',async()=>{
    const f=await fixture();await f.host.reconcile();await f.phase('admission');
    await f.host.store.change(f.tree.id,'fixture.expired',tree=>{tree.limits.expiresAt=Date.now()-1;});
    await f.host.reconcile();await f.phase('cancelled');expect(f.turn).not.toHaveBeenCalled();
});


it('waits for a cancelled reservation owner to settle before retrying a sibling',async()=>{
    const f=await fixture();await f.host.reconcile();await f.phase('admission');
    await f.host.cancel(f.tree.id,'pending');await f.host.reconcile();
    expect((await f.read()).tasks[f.tree.id].phase).toBe('admission');
    expect(f.turn).not.toHaveBeenCalled();
    await f.settle(500);await f.host.reconcile();await f.phase('completed');
    expect(f.turn).toHaveBeenCalledTimes(1);
    expect((await f.read()).tasks.pending.phase).toBe('cancelled');
});

it('does not await cancelled reservations indefinitely after restart',async()=>{
    const f=await fixture();await f.host.reconcile();await f.phase('admission');
    await f.host.cancel(f.tree.id,'pending');
    const resource=resources.find(r=>r.host===f.host)!;await f.host.close();
    resource.host=await StandaloneHarness.open({ contextTokens: 16000,dataDir:resource.path,provider:{turn:f.turn,structured:vi.fn()},rootTools:[]});
    await vi.waitFor(async()=>expect((await resource.host.store.get(f.tree.id))!.tasks[f.tree.id].phase).toBe('failed'));
    const tree=(await resource.host.store.get(f.tree.id))!;
    expect(tree.tasks.pending.phase).toBe('cancelled');expect(tree.tasks.pending.operationId).toBeUndefined();
    expect(tree.chargedTokens).toBe(4000);expect(f.turn).not.toHaveBeenCalled();
});


it('counts only releasable live reservations when bounding preparation', async () => {
    const f = await fixture();
    expect(preparationCapacity(await f.read())).toBe(5000);
    await f.host.store.change(f.tree.id, 'fixture.cancelled', tree => {
        tree.tasks.pending.phase = 'cancelled';
    });
    expect(preparationCapacity(await f.read())).toBe(5000);
    await f.settle(undefined);
    expect(preparationCapacity(await f.read())).toBe(1000);
    await f.host.store.change(f.tree.id, 'fixture.overspent', tree => { tree.chargedTokens = 6000; });
    expect(preparationCapacity(await f.read())).toBe(0);
});

it('keeps the configured context and accounts usage without an implicit spending allowance', async () => {
    const path = await mkdtemp(join(tmpdir(), 'uncapped-admission-'));
    const turn = vi.fn(async () => ({ message: { role: 'assistant' as const, content: 'done' }, stopReason: 'end_turn' as const, usage: { inputTokens: 100, outputTokens: 20 } }));
    const host = await StandaloneHarness.open({ dataDir: path, provider: { turn, structured: vi.fn() }, contextTokens: 16000, rootTools: [] });
    resources.push({ host, path });
    const tree = await host.store.create('Finish the task', [], host.compositionId);
    await host.store.change(tree.id, 'fixture.previous-usage', current => {
        current.chargedTokens = 300000;
        current.usage = { inputTokens: 300000, outputTokens: 0 };
    });
    await host.reconcile();
    await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].phase).toBe('completed'));
    const saved = (await host.store.get(tree.id))!;
    expect(saved.limits).not.toHaveProperty('tokens');
    expect(saved.chargedTokens).toBe(300120);
    expect(saved.usage).toEqual({ inputTokens: 300100, outputTokens: 20 });
    expect(turn).toHaveBeenCalledTimes(1);
    const intent = (await host.store.events(tree.id)).find(event => event.type === 'model.intent')!;
    expect(intent.data).toMatchObject({ context: { tokenBudget: 16000 } });
    expect(JSON.stringify(intent.data)).not.toContain('remainingSharedTokensBeforeThisRequest');
});

it('does not turn outstanding liabilities into an implicit limit when spending is uncapped', () => {
    const tree = { limits: {}, chargedTokens: 300000, tasks: { pending: { phase: 'unknown', reservation: 300000 } } } as unknown as Tree;
    const before = structuredClone(tree);
    expect(preparationCapacity(tree)).toBeUndefined();
    expect(admissionWait(tree, 50000)).toBeUndefined();
    expect(tree).toEqual(before);
});

import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { string } from './tools.js';
import type { StandaloneHarness } from './host.js';
/** Optional UI adapter. Closing a browser does not own or stop agent execution. */
export async function attachWeb(host: StandaloneHarness, options: {
    token: string;
    port?: number;
    hostname?: string;
}) {
    if (!options.token.trim())
        throw new Error('A nonempty web access token is required');
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
        try {
            if (req.method === 'GET' && req.url === '/') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(page);
                return;
            }
            const token = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''), expected = Buffer.from(options.token);
            if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
                res.writeHead(401);
                res.end('Authentication required');
                return;
            }
            const url = new URL(req.url ?? '/', 'http://local'), parts = url.pathname.split('/').filter(Boolean);
            let result: unknown;
            if (req.method === 'GET' && url.pathname === '/api/tasks')
                result = (await host.store.list(false, { limit: count(url.searchParams.get('limit'), 20, 50), offset: count(url.searchParams.get('offset'), 0, 1000000) })).map(tree => ({ id: tree.id, revision: tree.revision, usage: tree.usage, modelCalls: tree.modelCalls, limits: tree.limits,
                    artifacts: Object.keys(tree.artifacts), tasks: Object.values(tree.tasks).map(t => ({ id: t.id, parentId: t.parentId, title: t.title, phase: t.phase, notes: t.notes, answer: t.answer, error: t.error, wakeAt: t.wakeAt, calls: t.calls })) }));
            else if (req.method === 'POST' && url.pathname === '/api/tasks') {
                const body = await json(req);
                result = await host.create(string(body.prompt, 32000));
            }
            else if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2]) {
                const id = parts[2];
                if (req.method === 'GET' && parts[3] === 'events')
                    result = await host.store.events(id, count(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER));
                else if (req.method === 'GET' && parts[3] === 'artifact') {
                    const tree = await host.store.get(id);
                    result = { content: tree?.artifacts[url.searchParams.get('name') ?? ''] };
                }
                else if (req.method === 'POST' && parts[3] === 'cancel') {
                    const body = await json(req);
                    await host.cancel(id, body.taskId === undefined ? id : string(body.taskId, 100));
                    result = { ok: true };
                }
                else if (req.method === 'POST' && parts[3] === 'message') {
                    const body = await json(req);
                    await host.send(id, body.taskId === undefined ? id : string(body.taskId, 100), string(body.message, 8000));
                    result = { ok: true };
                }
                else {
                    res.writeHead(404);
                    res.end();
                    return;
                }
            }
            else {
                res.writeHead(404);
                res.end();
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
        }
        catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4318, options.hostname ?? '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    return { server, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
function count(value: string | null, fallback: number, max: number) {
    if (value === null)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max)
        throw new Error('Invalid page or event cursor');
    return parsed;
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 40000)
            throw new Error('Request too large');
        chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('Expected object');
    return body;
}
const page = String.raw `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gears Agent</title>
<style>body{font:16px system-ui;margin:0;background:#10151d;color:#e5edf7}main{max-width:920px;margin:auto;padding:24px}h1{font-size:28px}p{color:#aabacf}input,textarea,button{font:inherit;border:1px solid #41526a;border-radius:8px;padding:10px;background:#192331;color:inherit;box-sizing:border-box}input,textarea{width:100%;margin:6px 0}textarea{min-height:90px}button{cursor:pointer;margin:5px 8px 5px 0;background:#214b66}.card{border:1px solid #354155;border-radius:12px;padding:16px;margin:16px 0}.child{margin-left:20px;border-left:3px solid #477e97;padding-left:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px system-ui}.status{color:#74d6c5}#error{color:#ffb0a6}small{color:#aabacf}</style>
<main><h1>Gears Agent</h1><p>Durable tasks · delegated work · scheduled continuations</p><div id="login"><input id="token" type="password" placeholder="Access token" autocomplete="off"><button id="connect">Connect</button></div>
<div id="app" hidden><textarea id="prompt" placeholder="What should the agent accomplish?"></textarea><button id="create">Start task</button><p>20 task trees per page</p><button id="previous">Newer</button><button id="next">Older</button><div id="tasks"></div><section id="artifact" class="card" hidden></section></div><pre id="error"></pre></main>
<script>let token='',busy=false,lastRender='',offset=0;const $=id=>document.getElementById(id);async function api(path,body){const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();if(!r.ok)throw Error(text);return JSON.parse(text)}
function el(tag,text,parent,cls){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;parent.append(e);return e}
function button(label,parent,fn){el('button',label,parent).onclick=()=>Promise.resolve().then(fn).catch(e=>$('error').textContent=e.message)}
async function refresh(){if(busy||!token)return;busy=true;try{const trees=await api('tasks?offset='+offset);const snapshot=JSON.stringify(trees);if(snapshot===lastRender)return;lastRender=snapshot;$('tasks').replaceChildren();for(const tree of trees){const card=el('section','',$('tasks'),'card');el('small',tree.id+' · '+tree.modelCalls+'/'+tree.limits.modelCalls+' model calls · '+(tree.usage.inputTokens+tree.usage.outputTokens)+' tokens',card);for(const t of tree.tasks){const box=el('div','',card,t.parentId?'child':'');el('h3',t.title,box);el('div',t.phase+(t.wakeAt?' · wakes '+new Date(t.wakeAt).toLocaleString():''),box,'status');if(t.notes)el('pre',t.notes,box);if(t.answer)el('pre',t.answer,box);if(t.error)el('pre',t.error,box);button('Message',box,async()=>{const message=prompt('Message for this task');if(message)await api('tasks/'+tree.id+'/message',{taskId:t.id,message});await refresh()});button('Stop',box,async()=>{await api('tasks/'+tree.id+'/cancel',{taskId:t.id});await refresh()})}for(const name of tree.artifacts)button('Artifact: '+name,card,async()=>{const r=await api('tasks/'+tree.id+'/artifact?name='+encodeURIComponent(name));const viewer=$('artifact');viewer.hidden=false;viewer.replaceChildren();el('h3',name,viewer);const view=el('pre',r.content??'Unavailable',viewer);view.scrollIntoView()})} $('error').textContent=''}catch(e){$('error').textContent=e.message}finally{busy=false}}
$('connect').onclick=async()=>{token=$('token').value;try{await api('tasks');$('login').hidden=true;$('app').hidden=false;await refresh()}catch(e){$('error').textContent=e.message}};$('create').onclick=async()=>{try{await api('tasks',{prompt:$('prompt').value});$('prompt').value='';await refresh()}catch(e){$('error').textContent=e.message}};$('previous').onclick=()=>{offset=Math.max(0,offset-20);lastRender='';refresh()};$('next').onclick=()=>{offset+=20;lastRender='';refresh()};setInterval(refresh,2000);</script></html>`;

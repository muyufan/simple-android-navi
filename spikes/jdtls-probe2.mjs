// Generic JDT LS probe: node jdtls-probe2.mjs <workspaceDir> <dataDir> <relFile> <0-basedLine> <0-basedChar>
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const EXT = 'C:/Users/mudengke/.vscode/extensions/redhat.java-1.58.0-win32-x64';
const PLUGINS = path.join(EXT, 'server/plugins');
const CONFIG = path.join(EXT, 'server/config_win');
const JAVA = path.join(EXT, 'jre/25.0.4.1-win32-x86_64/bin/java.exe');
const WORKSPACE = process.argv[2];
const DATA = process.argv[3];
const REL = process.argv[4];
const LINE = Number(process.argv[5] ?? 0);
const CHAR = Number(process.argv[6] ?? 0);
const launcher = readdirSync(PLUGINS).find(f => /^org\.eclipse\.equinox\.launcher_/.test(f));
mkdirSync(DATA, { recursive: true });

const server = spawn(JAVA, [
  '-Declipse.application=org.eclipse.jdt.ls.core.id1',
  '-Dosgi.bundles.defaultStartLevel=4',
  '-Declipse.product=org.eclipse.jdt.ls.core.product',
  '-Dosgi.checkConfiguration=true',
  `-Dosgi.sharedConfiguration.area=${CONFIG}`,
  '-Dosgi.sharedConfiguration.area.readOnly=true',
  '-Dosgi.configuration.cascaded=true',
  `-Dosgi.configuration.area=${DATA}/configuration`,
  '-Xms512m', '-Xmx1g',
  '--add-modules=ALL-SYSTEM',
  '--add-opens', 'java.base/java.util=ALL-UNNAMED',
  '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
  '-jar', path.join(PLUGINS, launcher), '-data', DATA,
], { stdio: ['pipe', 'pipe', 'pipe'] });

const log = [];
server.stderr.on('data', d => log.push('[stderr] ' + d.toString().trimEnd()));

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
const notifications = [];
const send = m => { const s = JSON.stringify(m); server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
function request(method, params, timeoutMs = 240000) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout: ' + method)), timeoutMs);
    pending.set(id, v => { clearTimeout(t); res(v); });
  });
}
const settings = { java: { import: { gradle: { enabled: false }, maven: { enabled: false } }, configuration: { updateBuildConfiguration: 'disabled' }, autobuild: { enabled: true } } };
const rootUri = 'file:///' + WORKSPACE.replace(/\\/g, '/');
const folders = [{ uri: rootUri, name: path.basename(WORKSPACE) }];

function onMessage(msg) {
  if (msg.id !== undefined && msg.method) {
    if (msg.method === 'workspace/configuration') send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => settings) });
    else if (msg.method === 'workspace/workspaceFolders') send({ jsonrpc: '2.0', id: msg.id, result: folders });
    else send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.id !== undefined) { const cb = pending.get(msg.id); if (cb) { pending.delete(msg.id); cb(msg.error ? { __error: msg.error } : msg.result); } return; }
  notifications.push(msg);
}
server.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, sep).toString());
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length < sep + 4 + len) break;
    const body = buf.slice(sep + 4, sep + 4 + len).toString();
    buf = buf.slice(sep + 4 + len);
    try { onMessage(JSON.parse(body)); } catch { }
  }
});
const waitFor = (pred, ms = 240000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = setInterval(() => {
    const hit = notifications.find(pred);
    if (hit) { clearInterval(tick); res(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(tick); rej(new Error('wait timeout')); }
  }, 250);
});

const fileUri = rootUri + '/' + REL;
try {
  await request('initialize', {
    processId: process.pid, rootUri, rootPath: WORKSPACE,
    capabilities: { workspace: { workspaceFolders: true, configuration: true }, textDocument: { definition: { linkSupport: true }, references: {} }, window: { workDoneProgress: true } },
    initializationOptions: { settings, extendedClientCapabilities: { classFileContentsSupport: true } }, workspaceFolders: folders,
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  await waitFor(m => m.method === 'language/status' && m.params.type === 'ServiceReady');
  console.log('refreshed:', [...new Set(notifications.filter(m => m.method === 'language/status').map(m => m.params.message).filter(s => /Refreshing/.test(s)))].join(' | '));

  const text = readFileSync(path.join(WORKSPACE, REL), 'utf8');
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: fileUri, languageId: 'java', version: 1, text } } });
  await new Promise(r => setTimeout(r, Number(process.env.SETTLE_MS || 3500)));
  const hov = await request('textDocument/hover', { textDocument: { uri: fileUri }, position: { line: LINE, character: CHAR } });
  console.log('hover:', JSON.stringify(hov).slice(0, 300));
  let syms = [];
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) {
    syms = await request('workspace/symbol', { query: 'TextView' });
    if (Array.isArray(syms) && syms.length > 0) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('symbol TextView hits:', Array.isArray(syms) ? syms.length : syms, 'after', Math.round((Date.now() - t0) / 1000) + 's');

  const def = await request('textDocument/definition', { textDocument: { uri: fileUri }, position: { line: LINE, character: CHAR } });
  console.log('definition:', JSON.stringify(def));
  const d = Array.isArray(def) ? def[0] : def;
  if (d?.uri) {
    console.log('  scheme:', new URL(d.uri).protocol);
    console.log('  container project:', (/\?=([^/]+)\//.exec(d.uri) || [])[1] || '(file uri)');
  }
  const diag = notifications.filter(m => m.method === 'textDocument/publishDiagnostics' && m.params.uri === fileUri);
  const msgs = diag.flatMap(m => m.params.diagnostics.map(x => `${x.severity}: ${x.message}`));
  console.log('diagnostics:', msgs.length ? msgs.join(' | ') : '(clean)');
} catch (e) {
  console.log('ERROR', e.message);
  console.log(log.slice(-20).join('\n'));
} finally {
  try { await request('shutdown', null, 8000); send({ jsonrpc: '2.0', method: 'exit' }); } catch { }
  setTimeout(() => { server.kill(); process.exit(0); }, 1200);
}

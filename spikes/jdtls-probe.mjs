// Spike harness: drive the installed JDT LS (redhat.java 1.58.0) over LSP.
// S1: does EclipseProjectImporter claim a .project folder that also has settings.gradle,
//     with java.import.gradle.enabled=false?
// S0: does go-to-definition into a source-less jar work, and does the server return
//     decompiled class contents via java/classFileContents?
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const EXT = 'C:/Users/mudengke/.vscode/extensions/redhat.java-1.58.0-win32-x64';
const PLUGINS = path.join(EXT, 'server/plugins');
const CONFIG = path.join(EXT, 'server/config_win');
const WORKSPACE = process.argv[2] || 'D:/code/simple-android-navi/spikes/fixtures/eclipse-proj';
const DATA = process.argv[3] || 'D:/code/simple-android-navi/spikes/tmp/jdtls-data';

const launcher = readdirSync(PLUGINS).find(f => /^org\.eclipse\.equinox\.launcher_/.test(f));
mkdirSync(DATA, { recursive: true });

const javaArgs = [
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
  '-jar', path.join(PLUGINS, launcher),
  '-data', DATA,
];

const JAVA = process.env.JDTLS_JAVA || 'C:/Users/mudengke/.vscode/extensions/redhat.java-1.58.0-win32-x64/jre/25.0.4.1-win32-x86_64/bin/java.exe';
const server = spawn(JAVA, javaArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
const log = [];
server.stderr.on('data', d => log.push('[stderr] ' + d.toString().trimEnd()));
server.stdout.on('data', d => log.push('[stdout] ' + d.toString().slice(0, 200)));

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
const notifications = [];

function send(msg) {
  const s = JSON.stringify(msg);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: ' + method)), timeoutMs);
    pending.set(id, v => { clearTimeout(t); resolve(v); });
  });
}

const settings = {
  java: {
    import: { gradle: { enabled: false }, maven: { enabled: false } },
    configuration: { updateBuildConfiguration: 'disabled' },
    autobuild: { enabled: true },
    trace: { server: 'off' },
  },
};

function onMessage(msg) {
  if (msg.id !== undefined && msg.method) {
    // server -> client request
    if (msg.method === 'workspace/configuration') {
      send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => settings) });
    } else if (msg.method === 'client/registerCapability' || msg.method === 'window/workDoneProgress/create') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'workspace/workspaceFolders') {
      send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///' + WORKSPACE.replace(/\\/g, '/'), name: path.basename(WORKSPACE) }] });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
    return;
  }
  if (msg.id !== undefined) {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg.error ? { error: msg.error } : msg.result); }
    return;
  }
  notifications.push(msg);
  if (msg.method === 'language/status') {
    console.log('  [status]', msg.params.type, '-', msg.params.message);
  }
}

server.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const header = buf.slice(0, sep).toString();
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buf.length < sep + 4 + len) break;
    const body = buf.slice(sep + 4, sep + 4 + len).toString();
    buf = buf.slice(sep + 4 + len);
    try { onMessage(JSON.parse(body)); } catch (e) { console.log('  [parse-error]', e.message); }
  }
});

const waitFor = (pred, ms = 240000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = setInterval(() => {
    const hit = notifications.find(pred);
    if (hit) { clearInterval(tick); resolve(hit); }
    else if (Date.now() - t0 > ms) { clearInterval(tick); reject(new Error('wait timeout')); }
  }, 250);
});

const uri = 'file:///' + WORKSPACE.replace(/\\/g, '/');
const fileUri = uri + '/src/com/example/Use.java';

try {
  console.log('initialize…');
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: uri,
    rootPath: WORKSPACE,
    capabilities: {
      workspace: { workspaceFolders: true, configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: { definition: { linkSupport: true }, references: {}, hover: { contentFormat: ['plaintext'] } },
      window: { workDoneProgress: true },
    },
    initializationOptions: { settings, extendedClientCapabilities: { classFileContentsSupport: true } },
    workspaceFolders: [{ uri, name: path.basename(WORKSPACE) }],
  }, 300000);
  console.log('  server capabilities: definitionProvider=', !!init?.capabilities?.definitionProvider);
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  console.log('waiting for ServiceReady…');
  await waitFor(m => m.method === 'language/status' && (m.params.type === 'ServiceReady' || m.params.type === 'Error'));
  const ready = notifications.filter(m => m.method === 'language/status').map(m => m.params.type);
  console.log('  status seen:', ready.join(','));

  // --- S1 probe: which projects does JDT know about?
  console.log('\n[S1] executeCommand java.project.listSourcePaths.command');
  const srcPaths = await request('workspace/executeCommand', { command: 'java.project.listSourcePaths.command', arguments: [{}] });
  const flat = JSON.stringify(srcPaths || {});
  console.log('  result:', flat.slice(0, 1200));

  // --- S1 probe 2: workspace/symbol on the Eclipse project's class
  const sym = await request('workspace/symbol', { query: 'Hello' });
  console.log('  [S1] workspace/symbol Hello ->', JSON.stringify(sym || []).slice(0, 500));

  // --- S0 probe: definition on `Greeter` inside the jar
  const text = 'package com.example;\nimport com.lib.Greeter;\npublic class Use {\n    public String run() {\n        Greeter g = new Greeter();\n        return g.greet("world");\n    }\n}\n';
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: fileUri, languageId: 'java', version: 1, text } } });
  await new Promise(r => setTimeout(r, 4000));
  const line = 4, col = 10; // `Greeter` in `        Greeter g = new Greeter();`
  console.log('\n[S0] textDocument/definition at 5:11 (jar class)');
  const def = await request('textDocument/definition', { textDocument: { uri: fileUri }, position: { line, character: col } });
  console.log('  definition ->', JSON.stringify(def).slice(0, 600));

  const target = Array.isArray(def) ? def[0] : def;
  if (target?.uri?.startsWith('jdt://')) {
    console.log('  [S0] requesting java/classFileContents for', target.uri);
    const contents = await request('java/classFileContents', { uri: target.uri });
    const body = typeof contents === 'string' ? contents : JSON.stringify(contents);
    console.log('  classFileContents length:', body.length);
    console.log('  head:\n' + body.split('\n').slice(0, 14).map(l => '    ' + l).join('\n'));
    console.log('  decompiled?', /class Greeter|String greet\(/.test(body));
  } else {
    console.log('  [S0] no jdt:// uri; skipping classFileContents');
  }

  // --- references probe
  const refs = await request('textDocument/references', { textDocument: { uri: fileUri }, position: { line, character: col }, context: { includeDeclaration: true } });
  console.log('\n[refs] textDocument/references ->', JSON.stringify(refs).slice(0, 400));
} catch (e) {
  console.log('ERROR', e.message);
  console.log('--- server output tail ---');
  console.log(log.slice(-40).join('\n'));
} finally {
  try { await request('shutdown', null, 10000); send({ jsonrpc: '2.0', method: 'exit' }); } catch { }
  setTimeout(() => { server.kill(); process.exit(0); }, 1500);
}

// Probe: does JDT LS offer an import quick fix (i.e. auto-import) on the classpath we produce?
import { spawn } from 'node:child_process';
import path from 'node:path';

const EXT = 'C:/Users/mudengke/.vscode/extensions/redhat.java-1.58.0-win32-x64';
const PLUGINS = path.join(EXT, 'server/plugins');
const CONFIG = path.join(EXT, 'server/config_win');
const JAVA = path.join(EXT, 'jre/25.0.4.1-win32-x86_64/bin/java.exe');
const WORKSPACE = 'D:/code/simple-android-navi/spikes/fixtures/androidjar';
const DATA = 'D:/code/simple-android-navi/spikes/tmp/data-import';

const launcher = (await import('node:fs')).readdirSync(PLUGINS).find((f) => /^org\.eclipse\.equinox\.launcher_/.test(f));
(await import('node:fs')).mkdirSync(DATA, { recursive: true });

const server = spawn(JAVA, [
  '-Declipse.application=org.eclipse.jdt.ls.core.id1',
  '-Dosgi.bundles.defaultStartLevel=4',
  '-Declipse.product=org.eclipse.jdt.ls.core.product',
  '-Dosgi.checkConfiguration=true',
  `-Dosgi.sharedConfiguration.area=${CONFIG}`,
  '-Dosgi.sharedConfiguration.area.readOnly=true',
  '-Dosgi.configuration.cascaded=true',
  `-Dosgi.configuration.area=${DATA}/configuration`,
  '-Xms512m', '-Xmx1g', '--add-modules=ALL-SYSTEM',
  '--add-opens', 'java.base/java.util=ALL-UNNAMED',
  '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
  '-jar', path.join(PLUGINS, launcher), '-data', DATA,
], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
const notifications = [];
const send = (m) => { const s = JSON.stringify(m); server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
function request(method, params, timeoutMs = 240000) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout: ' + method)), timeoutMs);
    pending.set(id, (v) => { clearTimeout(t); res(v); });
  });
}
const settings = { java: { import: { gradle: { enabled: false }, maven: { enabled: false } }, configuration: { updateBuildConfiguration: 'disabled' }, autobuild: { enabled: true } } };
const rootUri = 'file:///' + WORKSPACE;
const fileUri = `${rootUri}/src/com/x/AutoImport.java`;
const text = 'package com.x;\n\npublic class AutoImport {\n    public void f(TextView tv) {\n    }\n}\n';

server.stdout.on('data', (chunk) => {
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
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'workspace/configuration') send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => settings) });
      else send({ jsonrpc: '2.0', id: msg.id, result: null });
      continue;
    }
    if (msg.id !== undefined) { const cb = pending.get(msg.id); if (cb) { pending.delete(msg.id); cb(msg.error ? { __error: msg.error } : msg.result); } return; }
    notifications.push(msg);
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

try {
  await request('initialize', {
    processId: process.pid, rootUri, rootPath: WORKSPACE,
    capabilities: {
      workspace: { workspaceFolders: true, configuration: true },
      textDocument: {
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source'] } }, isPreferredSupport: true },
        publishDiagnostics: { relatedInformation: true },
      },
      window: { workDoneProgress: true },
    },
    initializationOptions: { settings, extendedClientCapabilities: { classFileContentsSupport: true, resolveAdditionalTextEditsSupport: true } },
    workspaceFolders: [{ uri: rootUri, name: 'androidjar' }],
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  await waitFor((m) => m.method === 'language/status' && m.params.type === 'ServiceReady');

  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: fileUri, languageId: 'java', version: 1, text } } });
  await new Promise((r) => setTimeout(r, 6000));

  const diags = notifications.filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === fileUri).flatMap((m) => m.params.diagnostics);
  console.log('diagnostics:', diags.map((d) => d.message).join(' | ') || '(none)');

  const actions = await request('textDocument/codeAction', {
    textDocument: { uri: fileUri },
    range: { start: { line: 3, character: 18 }, end: { line: 3, character: 26 } },
    context: { diagnostics: diags },
  });
  const titles = (actions ?? []).map((a) => (a.title ? `${a.title} [${a.kind ?? '?'}]` : JSON.stringify(a).slice(0, 80)));
  console.log('code actions:', titles.length ? titles.join(' | ') : '(none)');

  const importAction = (actions ?? []).find((a) => /import/i.test(a.title ?? ''));
  if (importAction) {
    const resolved = importAction.edit ? importAction : await request('codeAction/resolve', importAction);
    const edits = (resolved.edit?.changes?.[fileUri] ?? resolved.edit?.documentChanges?.[0]?.edits ?? []);
    console.log('import edit:', JSON.stringify(edits).slice(0, 300));
  }
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  try { await request('shutdown', null, 8000); send({ jsonrpc: '2.0', method: 'exit' }); } catch { }
  setTimeout(() => { server.kill(); process.exit(0); }, 1200);
}

// `npm run verify` — end-to-end smoke test, no VS Code UI required.
//
// 1. runs the real init script through the project's Gradle wrapper
// 2. plans + writes the .project/.classpath model with the same code the extension uses
// 3. boots the installed JDT LS (redhat.java) and asserts go-to-definition targets
//
// Usage: node scripts/verify.mjs [--project=<dir>] [--variant=debug] [--keep]
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planModel, writePlan } = require('../out/verify-model.cjs');

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const configPath = path.join(repoRoot, 'verify.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const projectRoot = path.resolve(argOf('project', config.project));
const variant = argOf('variant', config.variant ?? 'debug');
const initScript = path.join(repoRoot, 'gradle', 'android-navi-model.gradle');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- step 1: gradle model
function gradlew(root) {
  const bat = path.join(root, 'gradlew.bat');
  if (process.platform === 'win32' && fs.existsSync(bat)) return bat;
  return path.join(root, 'gradlew');
}

async function dumpModel() {
  const wrapper = gradlew(projectRoot);
  const args = ['--init-script', initScript, '--no-configuration-cache', '-q', 'androidNaviModel'];
  console.log(`\n[1/3] ${path.basename(wrapper)} ${args.join(' ')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(`"${wrapper}"`, args, { cwd: projectRoot, shell: true, windowsHide: true });
    let sawModel = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (/^ANDROID_NAVI_MODEL=/m.test(text)) sawModel = true;
      if (/error:|FAILURE|Could not resolve/i.test(text)) process.stdout.write(text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`gradle exited with ${code}`));
      else if (!sawModel) reject(new Error('gradle produced no model marker'));
      else resolve();
    });
  });
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'build', 'android-navi-model.json'), 'utf8'));
}

// ---------------------------------------------------------------- step 2: emit model
function emit(model) {
  console.log(`\n[2/3] emitting .project/.classpath (variant ${variant})`);
  const plan = planModel(model, variant);
  const failing = model.entries.filter((e) => e.variant === variant && e.compileClasspathError);
  check('no variant reported a classpath error', failing.length === 0, failing.map((e) => e.project).join(', '));
  check('no foreign .project conflicts', plan.conflicts.length === 0, plan.conflicts.join(', '));
  check('every classpath entry exists on disk', plan.missingLibs.length === 0, `${plan.missingLibs.length} missing`);
  check('model covers at least one module', plan.projectNames.size > 0, `${plan.projectNames.size} modules`);
  const written = writePlan(plan);
  console.log(`      wrote ${written.length} files: ${[...plan.projectNames.values()].join(', ')}`);
}

// ---------------------------------------------------------------- step 3: JDT LS probes
function findRedhatJava() {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  const candidates = fs.readdirSync(dir).filter((d) => d.startsWith('redhat.java-')).sort().reverse();
  for (const candidate of candidates) {
    const base = path.join(dir, candidate);
    const plugins = path.join(base, 'server', 'plugins');
    if (!fs.existsSync(plugins)) continue;
    const launcher = fs.readdirSync(plugins).find((f) => /^org\.eclipse\.equinox\.launcher_/.test(f));
    if (!launcher) continue;
    const jreDir = path.join(base, 'jre');
    const jre = fs.existsSync(jreDir) ? fs.readdirSync(jreDir)[0] : undefined;
    const java = jre
      ? path.join(jreDir, jre, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
      : process.platform === 'win32'
        ? 'java.exe'
        : 'java';
    const configDir = path.join(base, 'server', process.platform === 'win32' ? 'config_win' : 'config_linux');
    return { base, plugins, launcher, java, configDir };
  }
  throw new Error('redhat.java not found in ~/.vscode/extensions');
}

function startJdtls(dataDir) {
  const { plugins, launcher, java, configDir } = findRedhatJava();
  fs.mkdirSync(dataDir, { recursive: true });
  return spawn(java, [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Dosgi.checkConfiguration=true',
    `-Dosgi.sharedConfiguration.area=${configDir}`,
    '-Dosgi.sharedConfiguration.area.readOnly=true',
    '-Dosgi.configuration.cascaded=true',
    `-Dosgi.configuration.area=${dataDir}/configuration`,
    '-Xms512m', '-Xmx2g',
    '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '-jar', path.join(plugins, launcher),
    '-data', dataDir,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function lsp(server) {
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  const send = (m) => {
    const s = JSON.stringify(m);
    server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  const request = (method, params, timeoutMs = 240000) => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${method}`)), timeoutMs);
      pending.set(id, (v) => { clearTimeout(t); res(v); });
    });
  };
  const settings = {
    java: {
      import: { gradle: { enabled: false }, maven: { enabled: false } },
      configuration: { updateBuildConfiguration: 'disabled' },
      autobuild: { enabled: true },
    },
  };
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
        if (msg.method === 'workspace/configuration') {
          send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => settings) });
        } else if (msg.method === 'workspace/workspaceFolders') {
          send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///' + projectRoot.replace(/\\/g, '/'), name: path.basename(projectRoot) }] });
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: null });
        }
        continue;
      }
      if (msg.id !== undefined) { const cb = pending.get(msg.id); if (cb) { pending.delete(msg.id); cb(msg.error ? { __error: msg.error } : msg.result); } continue; }
      notifications.push(msg);
    }
  });
  return { send, request, notifications, settings };
}

async function probe(server) {
  console.log('\n[3/3] JDT LS probes');
  const client = lsp(server);
  const rootUri = 'file:///' + projectRoot.replace(/\\/g, '/');

  await client.request('initialize', {
    processId: process.pid,
    rootUri,
    rootPath: projectRoot,
    capabilities: {
      workspace: { workspaceFolders: true, configuration: true },
      textDocument: { definition: { linkSupport: true }, references: {}, publishDiagnostics: {} },
      window: { workDoneProgress: true },
    },
    // Without classFileContentsSupport JDT LS answers [] for every definition inside a jar.
    initializationOptions: { settings: client.settings, extendedClientCapabilities: { classFileContentsSupport: true } },
    workspaceFolders: [{ uri: rootUri, name: path.basename(projectRoot) }],
  });
  client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  const t0 = Date.now();
  for (;;) {
    if (client.notifications.some((m) => m.method === 'language/status' && m.params.type === 'ServiceReady')) break;
    if (Date.now() - t0 > 300000) throw new Error('JDT LS never became ready');
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`      service ready after ${Math.round((Date.now() - t0) / 1000)}s`);

  for (const assertion of config.assertions) {
    const abs = path.join(projectRoot, assertion.file);
    const uri = `${rootUri}/${assertion.file}`;
    const text = fs.readFileSync(abs, 'utf8');
    client.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'java', version: 1, text } } });
    await new Promise((r) => setTimeout(r, assertion.settleMs ?? 6000));

    const definition = await client.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: assertion.line, character: assertion.char },
    });
    const target = Array.isArray(definition) ? definition[0] : definition;
    const targetUri = target?.uri ?? '';
    const schemeOk = targetUri.startsWith(assertion.expect);
    const includesOk = !assertion.expectIncludes || targetUri.replace(/\\/g, '/').includes(assertion.expectIncludes);
    check(assertion.label, Boolean(targetUri) && schemeOk && includesOk, targetUri.slice(0, 120) || 'no target');

    if (assertion.expectDiagnosticsClean) {
      const diags = client.notifications
        .filter((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri)
        .flatMap((m) => m.params.diagnostics)
        .filter((d) => d.severity === 1);
      check(`${assertion.label}: no error diagnostics`, diags.length === 0, diags.slice(0, 3).map((d) => d.message).join(' | '));
    }
  }
}

// ---------------------------------------------------------------- main
try {
  const model = await dumpModel();
  emit(model);
  const dataDir = path.join(repoRoot, 'out', 'verify-jdtls');
  const server = startJdtls(dataDir);
  try {
    await probe(server);
  } finally {
    server.kill();
  }
} catch (error) {
  check('verification run completed', false, error.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

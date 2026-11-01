import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findGradleRoots, runModelDump } from './gradle';
import { excludeFromGit, planModel, writePlan } from './model';
import { applyJavaSettings, restoreJavaSettings } from './settings';
import type { Model } from './types';

type StatusKind = 'idle' | 'syncing' | 'ready' | 'incomplete' | 'notAgp' | 'unavailable';

const STATUS_TEXT: Record<StatusKind, string> = {
  idle: '$(circle-outline) Android Navi',
  syncing: '$(sync~spin) Android Navi: syncing…',
  ready: '$(check) Android Navi',
  incomplete: '$(warning) Android Navi: incomplete',
  notAgp: '$(circle-slash) Android Navi: not an AGP project',
  unavailable: '$(error) Android Navi: redhat.java missing',
};

const DEFAULT_GRADLE_TIMEOUT_MINUTES = 20;
/** JDT commands can block while the language server is starting; never let that wedge the sync. */
const JDT_COMMAND_TIMEOUT_MS = 20_000;

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let syncing = false;
let syncCancellation: vscode.CancellationTokenSource | undefined;

let syncStartedAt = 0;
let syncDetail = '';
let syncTicker: NodeJS.Timeout | undefined;

function log(line: string): void {
  output.appendLine(line);
}

function setStatus(kind: StatusKind, detail?: string, tooltip?: string): void {
  status.text = STATUS_TEXT[kind] + (detail ? ` (${detail})` : '');
  status.tooltip = tooltip ?? detail;
  status.show();
}

function shortDetail(detail: string): string {
  return detail.length > 48 ? `${detail.slice(0, 47)}…` : detail;
}

/** The elapsed clock is what distinguishes "compiling" from "hung" at a glance. */
function renderSyncing(): void {
  const elapsed = Math.max(0, Math.floor((Date.now() - syncStartedAt) / 1000));
  const stamp = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  setStatus('syncing', `${stamp}${syncDetail ? ` · ${shortDetail(syncDetail)}` : ''}`);
  status.tooltip = `Android Navi is syncing${syncDetail ? ` (${syncDetail})` : ''}. Click to cancel.`;
}

function beginSyncStatus(): void {
  syncStartedAt = Date.now();
  syncDetail = '';
  status.command = 'androidNavi.cancelSync';
  renderSyncing();
  syncTicker = setInterval(renderSyncing, 1000);
}

function endSyncStatus(): void {
  if (syncTicker) clearInterval(syncTicker);
  syncTicker = undefined;
  status.command = 'androidNavi.showOutput';
}

/** Turns Gradle's plain-console output into a one-line "what is it doing" hint. */
function trackProgress(line: string): void {
  if (!syncing) return;
  const trimmed = line.trim();
  const task = /^> Task (\S+)/.exec(trimmed);
  if (task) {
    syncDetail = task[1];
    return;
  }
  if (trimmed.startsWith('Downloading ')) {
    syncDetail = 'downloading';
    return;
  }
  if (trimmed.startsWith('ANDROID_NAVI_MODEL=')) {
    syncDetail = 'writing model';
    return;
  }
  if (trimmed.startsWith('> ')) syncDetail = trimmed.slice(2);
}

/**
 * Resolves to 'timeout' instead of hanging when a JDT command never answers. The original promise
 * keeps its handlers attached via Promise.race, so a late rejection is not an unhandled rejection.
 */
async function withTimeout(
  thenable: Thenable<unknown>,
  ms: number,
  label: string,
): Promise<'done' | 'timeout' | 'error'> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(thenable),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          log(`  ${label} did not answer within ${Math.round(ms / 1000)}s; continuing.`);
          resolve();
        }, ms);
      }),
    ]);
  } catch (error) {
    log(`  ${label} failed (${(error as Error).message})`);
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
  return timedOut ? 'timeout' : 'done';
}

function initScriptPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath(path.join('gradle', 'android-navi-model.gradle'));
}

interface SyncOutcome {
  ok: boolean;
  modules: number;
  message: string;
  /** We flipped java.import.gradle.enabled, so JDT must drop its Gradle-imported projects. */
  gradleImporterDisabled: boolean;
  cancelled?: boolean;
}

async function syncFolder(
  folder: vscode.WorkspaceFolder,
  context: vscode.ExtensionContext,
  token: vscode.CancellationToken,
): Promise<SyncOutcome> {
  const root = folder.uri.fsPath;
  log('');
  log(`== syncing ${root}`);

  const javaExtension = vscode.extensions.getExtension('redhat.java');
  if (!javaExtension) {
    return { ok: false, modules: 0, message: 'redhat.java (Java Language Support) is not installed.', gradleImporterDisabled: false };
  }

  const applied = await applyJavaSettings(context.workspaceState, log);
  const settingsProblem = applied.failed.length > 0
    ? `could not disable the Java Gradle importer (${applied.failed.join(', ')}); navigation may stay half-broken`
    : undefined;
  if (settingsProblem) log(`! ${settingsProblem}`);

  const config = vscode.workspace.getConfiguration('androidNavi', folder.uri);
  const variant = config.get<string>('variant') ?? 'debug';
  const extraArgs = config.get<string[]>('extraGradleArgs') ?? [];
  const timeoutMinutes = config.get<number>('gradleTimeoutMinutes') ?? DEFAULT_GRADLE_TIMEOUT_MINUTES;

  const result = await runModelDump({
    projectRoot: root,
    initScript: initScriptPath(context),
    variant,
    extraArgs,
    timeoutMs: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : 0,
    onOutput: (line) => {
      log(line);
      trackProgress(line);
    },
    token: {
      get isCancellationRequested() {
        return token.isCancellationRequested;
      },
      onCancellationRequested: (cb) => token.onCancellationRequested(cb),
    },
  });

  if (!result.ok) {
    log(`! ${result.message}`);
    return {
      ok: false,
      modules: 0,
      message: result.message,
      gradleImporterDisabled: applied.gradleImporterDisabled,
      cancelled: result.killed,
    };
  }

  let model: Model;
  try {
    model = JSON.parse(fs.readFileSync(result.modelPath!, 'utf8')) as Model;
  } catch (error) {
    const message = `Model file is not valid JSON: ${(error as Error).message}`;
    log(`! ${message}`);
    return { ok: false, modules: 0, message, gradleImporterDisabled: applied.gradleImporterDisabled };
  }

  const failing = model.entries.filter((e) => e.compileClasspathError);
  for (const entry of failing) {
    log(`! ${entry.project}:${entry.variant} classpath error: ${entry.compileClasspathError}`);
  }

  const plan = planModel(model, variant);
  if (plan.conflicts.length > 0) {
    const message =
      'Refusing to overwrite an existing Eclipse project model: ' + plan.conflicts.join(', ');
    log(`! ${message}`);
    return { ok: false, modules: 0, message, gradleImporterDisabled: applied.gradleImporterDisabled };
  }
  if (plan.files.length === 0) {
    return { ok: false, modules: 0, message: `No module has a "${variant}" variant.`, gradleImporterDisabled: applied.gradleImporterDisabled };
  }
  if (plan.missingLibs.length > 0) {
    log(`! ${plan.missingLibs.length} classpath entries are missing on disk, e.g. ${plan.missingLibs[0]}`);
  }

  const written = writePlan(plan);
  excludeFromGit(root, written);
  log(`  wrote ${written.length} files for ${plan.projectNames.size} modules (variant ${variant})`);

  // Ask JDT LS to re-read the classpaths instead of paying a full workspace restart.
  for (const file of written.filter((f) => f.endsWith('.classpath'))) {
    const outcome = await withTimeout(
      vscode.commands.executeCommand('java.projectConfiguration.update', vscode.Uri.file(file)),
      JDT_COMMAND_TIMEOUT_MS,
      'java.projectConfiguration.update',
    );
    if (outcome !== 'done') {
      log('  try "Android Navi: Reload Java Model" if navigation stays stale');
      break;
    }
  }

  const modules = plan.projectNames.size;
  const message = settingsProblem
    ?? (failing.length > 0
      ? `model written for ${modules} modules, but ${failing.length} variant(s) reported classpath errors`
      : `ready: ${modules} modules (${variant})`);
  return {
    ok: settingsProblem === undefined && failing.length === 0,
    modules,
    message,
    gradleImporterDisabled: applied.gradleImporterDisabled,
  };
}

async function syncAll(context: vscode.ExtensionContext): Promise<void> {
  if (syncing) {
    const choice = await vscode.window.showWarningMessage(
      'Android Navi is already syncing. Cancel it?',
      'Cancel sync',
    );
    if (choice === 'Cancel sync') syncCancellation?.cancel();
    return;
  }

  const tokenSource = new vscode.CancellationTokenSource();
  syncCancellation = tokenSource;
  syncing = true;
  const results: ({ folder: vscode.WorkspaceFolder } & SyncOutcome)[] = [];
  try {
    const roots = findGradleRoots(vscode.workspace.workspaceFolders ?? []);
    if (roots.length === 0) {
      setStatus('notAgp', undefined, 'No settings.gradle(.kts) in this workspace.');
      log('No Gradle project found; nothing to do.');
      return;
    }

    beginSyncStatus();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (!roots.includes(folder.uri.fsPath)) continue;
      if (tokenSource.token.isCancellationRequested) break;
      try {
        const result = await syncFolder(folder, context, tokenSource.token);
        results.push({ folder, ...result });
      } catch (error) {
        // One folder failing must not abort the others, and must never leave "syncing…" behind.
        const message = `Sync failed: ${(error as Error).message}`;
        log(`! ${message}`);
        results.push({ folder, ok: false, modules: 0, message, gradleImporterDisabled: false });
      }
    }

    const cancelled = tokenSource.token.isCancellationRequested || results.some((r) => r.cancelled);
    const failed = results.filter((r) => !r.ok);
    const modules = results.reduce((sum, r) => sum + r.modules, 0);

    if (cancelled) {
      setStatus('idle', undefined, 'Sync cancelled.');
      log('Sync cancelled.');
    } else if (failed.length === 0) {
      setStatus('ready', `${modules} modules`, `Classpath synced for ${modules} modules.`);
    } else {
      const first = failed[0];
      setStatus('incomplete', first.message.slice(0, 40), `${first.message}\nSee "Android Navi: Show Output".`);
      output.show(true);
    }

    // Only prompt after the status shows the outcome: this message waits for the user, and awaiting
    // it before the status update made a finished sync look stuck at "syncing…".
    if (!cancelled && results.some((r) => r.gradleImporterDisabled)) {
      void ensureJavaReimport();
    }
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    log(`! sync aborted: ${message}`);
    setStatus('incomplete', 'sync failed', `${message}\nSee "Android Navi: Show Output".`);
    output.show(true);
  } finally {
    endSyncStatus();
    if (syncCancellation === tokenSource) syncCancellation = undefined;
    tokenSource.dispose();
    syncing = false;
  }
}

async function jdtProjectNames(): Promise<string[]> {
  let names: string[] | undefined;
  const outcome = await withTimeout(
    vscode.commands
      .executeCommand<string[]>('java.execute.workspaceCommand', 'java.project.getAll')
      .then((value) => {
        names = value;
      }),
    JDT_COMMAND_TIMEOUT_MS,
    'java.project.getAll',
  );
  return outcome === 'done' && Array.isArray(names) ? names : [];
}

/**
 * Disabling the Gradle importer does not retroactively drop the projects it already imported.
 * On a first sync they are still there under Gradle names (app, terminal-*, ...) with an
 * AGP-incompatible classpath, and JDT answers some definitions from that stale model — which looks
 * like "Ctrl-click works on one line but not another". They only go away when JDT re-imports.
 */
async function ensureJavaReimport(): Promise<void> {
  try {
    const names = await jdtProjectNames();
    const foreign = names.filter((name) => !name.startsWith('ani-') && name !== 'jdt.ls-java-project');
    if (foreign.length === 0) return;
    log(`! Java still holds Gradle-imported projects: ${foreign.join(', ')}`);
    const choice = await vscode.window.showInformationMessage(
      `Java still has Gradle-imported projects (${foreign.slice(0, 3).join(', ')}` +
        `${foreign.length > 3 ? ', …' : ''}). Android Navi needs Java to re-import this workspace once; ` +
        'until then, navigation uses the wrong classpath.',
      'Clean Java workspace and reload',
      'Later',
    );
    if (choice === 'Clean Java workspace and reload') {
      await vscode.commands.executeCommand('java.clean.workspace');
    }
  } catch (error) {
    log(`! could not inspect the Java workspace: ${(error as Error).message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Android Navi');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'androidNavi.showOutput';
  context.subscriptions.push(output, status);

  context.subscriptions.push(
    vscode.commands.registerCommand('androidNavi.sync', () => syncAll(context)),
    vscode.commands.registerCommand('androidNavi.cancelSync', () => {
      if (!syncCancellation) return;
      log('! cancel requested');
      syncCancellation.cancel();
    }),
    vscode.commands.registerCommand('androidNavi.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('androidNavi.restoreJavaSettings', async () => {
      await restoreJavaSettings(context.workspaceState, log);
      void vscode.window.showInformationMessage(
        'Android Navi: the java.* settings it changed have been reverted. Uninstalling the extension is safe now.',
      );
    }),
    vscode.commands.registerCommand('androidNavi.reloadJavaModel', async () => {
      await reconcileFromDisk();
      await vscode.commands.executeCommand('java.clean.workspace');
      await vscode.commands.executeCommand('java.server.restart');
    }),
  );

  const enabled = vscode.workspace.getConfiguration('androidNavi').get<boolean>('syncOnStartup') ?? true;
  if (!enabled) {
    setStatus('idle');
    return;
  }

  if (!vscode.extensions.getExtension('redhat.java')) {
    setStatus('unavailable', undefined, 'Install "Language Support for Java(TM) by Red Hat" first.');
    return;
  }

  void syncAll(context);
}

/**
 * After a restart, `.classpath` files written by a previous run are still on disk; rewriting them
 * (without a Gradle run) is enough for JDT LS to pick up navigation again.
 */
async function reconcileFromDisk(): Promise<void> {
  const roots = findGradleRoots(vscode.workspace.workspaceFolders ?? []);
  for (const root of roots) {
    const variant = vscode.workspace.getConfiguration('androidNavi', vscode.Uri.file(root)).get<string>('variant') ?? 'debug';
    const modelPath = path.join(root, 'build', 'android-navi-model.json');
    if (!fs.existsSync(modelPath)) {
      log(`No model at ${modelPath}; run "Android Navi: Sync Android Classpath".`);
      continue;
    }
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as Model;
    const plan = planModel(model, variant);
    if (plan.conflicts.length === 0) {
      writePlan(plan);
      log(`Re-applied model for ${plan.projectNames.size} modules from disk (${variant}).`);
    }
  }
}

export async function deactivate(): Promise<void> {
  // A sync still running would keep Gradle alive after the window is gone.
  syncCancellation?.cancel();
  // The java.* settings deliberately stay: they are window scoped, JDT LS reads them when the next
  // window starts, and reverting them here let the Gradle importer claim the workspace again before
  // this extension could re-apply them (so "clean workspace and reload" never converged).
  // "Android Navi: Restore Java Settings" undoes them before uninstalling.
}

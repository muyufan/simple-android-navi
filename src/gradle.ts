import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CancelToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (cb: () => void) => { dispose(): void } | void;
}

export interface DumpOptions {
  projectRoot: string;
  initScript: string;
  variant: string;
  extraArgs: string[];
  onOutput: (line: string) => void;
  /** Abort the build after this long. 0 or undefined = no limit. */
  timeoutMs?: number;
  token?: CancelToken;
}

export interface DumpResult {
  ok: boolean;
  killed: boolean;
  /** We stopped the build because it exceeded `timeoutMs`. */
  timedOut?: boolean;
  /** Parsed path of the model json, if the task reported one. */
  modelPath?: string;
  message: string;
}

/** A workspace folder is an AGP candidate if it has a Gradle settings file. */
export function findGradleRoots(folders: readonly { uri: { fsPath: string } }[]): string[] {
  return folders
    .map((f) => f.uri.fsPath)
    .filter((dir) => fs.existsSync(path.join(dir, 'settings.gradle')) || fs.existsSync(path.join(dir, 'settings.gradle.kts')));
}

function wrapperFor(root: string): string | undefined {
  const bat = path.join(root, 'gradlew.bat');
  const sh = path.join(root, 'gradlew');
  if (process.platform === 'win32' && fs.existsSync(bat)) return bat;
  if (fs.existsSync(sh)) return sh;
  return fs.existsSync(bat) ? bat : undefined;
}

function shellQuote(arg: string): string {
  if (process.platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `child.kill()` on Windows only kills the cmd.exe we spawned with shell:true; the Gradle daemon
 * client keeps running and holds the build lock. taskkill /T kills the whole tree.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // fall through to child.kill()
    }
  }
  child.kill();
}

/**
 * Runs the model dump. The task depends on the variant compile tasks inside Gradle:
 * generated sources (BuildConfig) and R.jar only exist once those have run in the same build.
 */
export function runModelDump(options: DumpOptions): Promise<DumpResult> {
  const wrapper = wrapperFor(options.projectRoot);
  if (!wrapper) {
    return Promise.resolve({
      ok: false,
      killed: false,
      message: 'No Gradle wrapper (gradlew / gradlew.bat) in this folder. Open the project root.',
    });
  }

  const args = [
    '--init-script', options.initScript,
    '--no-configuration-cache',
    // Not -q: the "> Task :app:compileDebugJavaWithJavac" lines are what the status bar reports,
    // so a long compile looks alive instead of hung.
    '--console=plain',
    'androidNaviModel',
    ...options.extraArgs,
  ];

  // Quote every argument: Node joins an args array with spaces when shell:true, so a wrapper or
  // init script under "C:\Users\First Last\..." (or extraGradleArgs with spaces) arrived split.
  const commandLine = [wrapper, ...args].map(shellQuote).join(' ');
  options.onOutput(`> ${commandLine}`);

  return new Promise<DumpResult>((resolve) => {
    const child = spawn(commandLine, {
      cwd: options.projectRoot,
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    });

    let settled = false;
    let killed = false;
    let timedOut = false;
    let modelPath: string | undefined;
    let tail = '';
    let timer: NodeJS.Timeout | undefined;
    let cancelListener: { dispose(): void } | undefined;

    const finish = (result: DumpResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cancelListener?.dispose();
      resolve(result);
    };

    const onLine = (line: string) => {
      if (!line.trim()) return;
      options.onOutput(line);
      tail = (tail + line + '\n').slice(-4000);
      const match = /^ANDROID_NAVI_MODEL=(.+)$/m.exec(line);
      if (match) modelPath = match[1].trim();
    };

    let buffer = '';
    const pump = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      lines.forEach(onLine);
    };
    child.stdout.on('data', pump);
    child.stderr.on('data', pump);

    const listener = options.token?.onCancellationRequested(() => {
      killed = true;
      options.onOutput('! cancelled');
      killTree(child);
      finish({ ok: false, killed: true, message: 'Sync cancelled.' });
    });
    if (listener) cancelListener = listener;

    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
        options.onOutput(`! Gradle did not finish within ${minutes} min; stopping it.`);
        killTree(child);
        finish({
          ok: false,
          killed: false,
          timedOut: true,
          message: `Gradle did not finish within ${minutes} min and was stopped.`,
        });
      }, timeoutMs);
    }

    child.on('error', (err) => {
      finish({ ok: false, killed, timedOut, message: `Failed to start Gradle: ${err.message}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      if (buffer) onLine(buffer);
      if (killed) {
        finish({ ok: false, killed: true, message: 'Sync cancelled.' });
        return;
      }
      if (timedOut) {
        finish({ ok: false, killed: false, timedOut: true, message: 'Gradle was stopped after the timeout.' });
        return;
      }
      if (code !== 0) {
        const hint = /Could not resolve all (files|dependencies)/.test(tail)
          ? ' Build failed while resolving dependencies.'
          : '';
        finish({ ok: false, killed: false, message: `Gradle exited with code ${code}.${hint}` });
        return;
      }
      const reported = modelPath ?? path.join(options.projectRoot, 'build', 'android-navi-model.json');
      if (!fs.existsSync(reported)) {
        finish({ ok: false, killed: false, message: 'Gradle succeeded but no model file was produced.' });
        return;
      }
      finish({ ok: true, killed: false, modelPath: reported, message: 'ok' });
    });
  });
}

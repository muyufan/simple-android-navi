import * as vscode from 'vscode';

/**
 * Settings we must force so JDT LS never reaches for the Gradle importer (which cannot model AGP)
 * and never overwrites our generated model.
 *
 * redhat.java declares all three as `"scope": "window"` — JDT LS is one server per window, so there
 * is no per-folder value. Writing them at `ConfigurationTarget.WorkspaceFolder` is rejected by
 * VS Code ("java.import.gradle.enabled does not support the folder resource scope"); because that
 * rejection escaped `applyJavaSettings`, the status bar stayed at "syncing…" forever and Gradle was
 * never started. Workspace scope is the narrowest target that actually works.
 */
const FORCED: Record<string, unknown> = {
  'java.import.gradle.enabled': false,
  'java.import.maven.enabled': false,
  'java.configuration.updateBuildConfiguration': 'disabled',
};

interface WrittenSetting {
  key: string;
  /** Value we wrote, so we only revert settings that are still exactly ours. */
  value: unknown;
  /** Workspace value before we wrote ours (undefined when there was none). */
  previous: unknown;
}

const STATE_KEY = 'androidNavi.writtenJavaSettings';

export interface ApplyResult {
  /** True when we changed `java.import.gradle.enabled` — JDT must re-import the workspace. */
  gradleImporterDisabled: boolean;
  /** Keys we could not write, e.g. because the workspace settings file is read-only. */
  failed: string[];
}

export async function applyJavaSettings(
  state: vscode.Memento,
  log: (line: string) => void,
): Promise<ApplyResult> {
  let gradleImporterDisabled = false;
  const failed: string[] = [];
  const written: WrittenSetting[] = [];
  // No resource: these keys are window scoped, and passing a folder URI for them makes VS Code warn.
  const config = vscode.workspace.getConfiguration();

  for (const [key, value] of Object.entries(FORCED)) {
    const current = config.get(key);
    if (JSON.stringify(current) === JSON.stringify(value)) {
      log(`  java setting already correct: ${key} = ${JSON.stringify(value)}`);
      continue;
    }
    const previous = config.inspect(key)?.workspaceValue;
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      // A read-only settings file must not abort the sync before Gradle has run.
      log(`! could not set ${key} = ${JSON.stringify(value)}: ${(error as Error).message}`);
      failed.push(key);
      continue;
    }
    if (key === 'java.import.gradle.enabled') gradleImporterDisabled = true;
    written.push({ key, value, previous });
    log(`  java setting applied: ${key} = ${JSON.stringify(value)}`);
  }

  if (written.length > 0) {
    const previous = state.get<WrittenSetting[]>(STATE_KEY) ?? [];
    await state.update(STATE_KEY, [...previous, ...written]);
  }
  return { gradleImporterDisabled, failed };
}

/**
 * Reverts only the values we set and only if they are unchanged, so uninstalling the extension
 * cannot leave `java.import.gradle.enabled=false` behind on a user's plain Gradle project.
 * A workspace value that existed before we wrote ours is restored, not deleted.
 */
export async function restoreJavaSettings(
  state: vscode.Memento,
  log: (line: string) => void,
): Promise<void> {
  // Records written by the folder-scoped version have no `previous`; they were never applied
  // (the write was rejected), so drop them instead of guessing what to restore.
  const written = (state.get<WrittenSetting[]>(STATE_KEY) ?? []).filter((r) => 'previous' in r);
  if (written.length === 0) {
    await state.update(STATE_KEY, []);
    return;
  }

  const config = vscode.workspace.getConfiguration();
  const remaining: WrittenSetting[] = [];
  for (const record of written) {
    if (JSON.stringify(config.get(record.key)) !== JSON.stringify(record.value)) {
      log(`  leaving ${record.key} alone (changed since we set it)`);
      continue;
    }
    try {
      await config.update(record.key, record.previous, vscode.ConfigurationTarget.Workspace);
      log(`  java setting reverted: ${record.key}`);
    } catch (error) {
      log(`! could not revert ${record.key}: ${(error as Error).message}`);
      remaining.push(record);
    }
  }
  await state.update(STATE_KEY, remaining);
}

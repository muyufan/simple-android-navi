# Android Navi — spike results

Environment: Windows, `ANDROID_HOME=D:\code\android\sdk` (platforms 34/35/36/37.0, **no `sources/` package**),
JDK 21 on PATH, `redhat.java-1.58.0` installed (JDT LS core 1.63, bundles own JRE 25 + FernFlower).
Network: Google Maven reachable; **github.com blocked**; gradle services redirect to github → blocked.

## S0 — go-to-definition into a source-less jar (PASS)

Harness: `spikes/jdtls-probe.mjs` (drives the installed JDT LS over raw LSP, no VS Code needed).

```
fixtures/eclipse-proj/libs/lib.jar  (com.lib.Greeter, no sources attached)
textDocument/definition at Use.java:5:11 ->
  [{"uri":"jdt://contents/lib.jar/com.lib/Greeter.java?=S1Marker/libs%5C/lib.jar%3Ccom.lib%28Greeter.class", ...}]
java/classFileContents -> 249 chars, header:
  // Source code is decompiled from a .class file using FernFlower decompiler (from Intellij IDEA).
  public String greet(String var1) { return "hi " + var1; }
textDocument/references -> hits in the open file (import + usage)
```

**Consequence:** we ship no decompiler and no virtual documents. JDT LS already decompiles via FernFlower
and `java.references.includeDecompiledSources` exists as a setting. Deleting this from the design removed
the single largest subsystem we had planned.

Also: JDT LS 1.63 requires `osgi.ee=JavaSE 25`; launching with JDK 21 fails with unresolved bundles
(`org.eclipse.core.filesystem` etc.). `redhat.java` ships `jre/25.0.4.1-win32-x86_64` and must be used.
Our extension never launches JDT LS, so this only affects test harnesses.

## S1 — `.project` vs Gradle importer (PASS)

Fixture `fixtures/s1b`: `.project` named **S1Marker**, plus a real `build.gradle` + `settings.gradle`
(so `GradleProjectImporter` is eligible), `java.import.gradle.enabled=false` sent via
`initializationOptions.settings`.

```
language/status: Refreshing '/S1Marker'
symbol/definition URIs carry container ?=S1Marker/...
```

**Consequence:** with the Gradle importer disabled, `EclipseProjectImporter` claims the folder, our
`.classpath` is authoritative, no duplicate project appears, and settings passed through
`initializationOptions` are honoured. The linchpin assumption holds — no fallback to a flattened
invisible project needed.

## S1c — multi-project, cross-module (PASS)

Fixture `fixtures/multi`: `mod-a` + `mod-b`, each its own `.project`; `mod-a/.classpath` has
`<classpathentry combineaccessrules="false" kind="src" path="/mod-b"/>`.

```
definition on Helper (mod-a/src/com/a/Caller.java) ->
  file:///.../mod-b/src/com/b/Helper.java   scheme: file:   diagnostics: (clean)
```

**Consequence:** per-module Eclipse projects with project-references give source-to-source
cross-module navigation, exactly like Android Studio. A sibling `classes.jar` on the classpath (what
Gradle actually reports) would have landed in *decompiled bytecode* instead — so the model must
convert sibling build outputs into project references.

## S2 — classpath acquisition from an init script (PASS, with 5 corrections)

Run against `termux-app-master` (Java, 4 modules, AGP 8.13.2) then `fixtures/android-min` (controlled).

**What works**

- Init script only, no build-file edits: `./gradlew -I android-navi-model.gradle dumpAndroidNaviModel`.
- `gradle.beforeProject { p -> p.pluginManager.withPlugin('com.android.application'|'.library') { … } }`
  is early enough to call `androidComponents.onVariants(...)` from an init script (8 variants seen).
  Calling `onVariants` from a task's `doLast` fails: *"It is too late to add actions as the callbacks
  already executed."* `androidComponents` is a **project** extension, not on the `android` extension.
- Legacy path `variant.getCompileConfiguration().resolve()` yields the complete per-variant classpath:
  own `R.jar`, sibling `classes.jar`, AAR jars from `~/.gradle/caches/*/transforms/*/…-api.jar`,
  plus Kotlin stdlib etc. On termux `:app:debug` = 74 entries.
- `android.bootClasspath` = `platforms/android-36/android.jar` + `build-tools/*/core-lambda-stubs.jar`.

**What breaks / corrections**

1. `variant.compileConfiguration` (androidComponents) is a multi-artifact configuration. Plain
   `.resolve()` throws `ArtifactSelectionException` once the project has a `project(...)` dependency
   (ambiguous between `android-classes-jar`, `r-class-jar`, `android-manifest`, `jar`…). Must go through
   `incoming.artifactView { attribute(artifactType, 'android-classes-jar') }`.
2. Even then, **own `R.jar` is not in that view** — `artifactType='r-class-jar'` returns the *dependency*
   modules' R jars only (`lib/build/intermediates/compile_r_class_jar/.../R.jar`). The legacy
   `getCompileConfiguration()` includes the module's own `R.jar`. This is why the legacy path is
   currently the only one-call complete classpath.
3. `variant.sources.java.all` is **task-output-backed**: querying it before
   `:app:generateDebugBuildConfig` has run *in the same build* throws
   *"Querying the mapped value … before task ':app:generateDebugBuildConfig' has completed is not supported"*.
   The dump task must `dependsOn <module>:compile<Variant>JavaWithJavac`. Once it does, the view returns
   `app/build/generated/source/buildConfig/debug` — the generated dirs we needed. Querying
   `variant.sources` eagerly inside the `onVariants` callback also fails (provider has no value yet):
   capture the provider, resolve in the dump task.
4. A build is unavoidable, and `:app:compileDebugJavaWithJavac` is the minimum that works:
   it produces `R.jar` (`build/intermediates/compile_and_runtime_not_namespaced_r_class_jar/debug/processDebugResources/R.jar`)
   and `BuildConfig.java`. Before any build, exactly 4 of 74 entries were missing (own `R.jar` + 3
   sibling `classes.jar`); after it, 0 missing.
5. AGP 8 has `buildConfig` generation **off by default** (`buildFeatures { buildConfig = true }`),
   so `BuildConfig` may legitimately not exist; the model must not assume it.

**Toolchain gotchas**

- Gradle **9.7.1 breaks AGP 8.13.2**: `InternalProblems` removed in Gradle 9.6. The project's own wrapper
  (9.2.1) is required. Use the wrapper, never a global Gradle.
- On this machine the 9.2.1 wrapper distribution is half-downloaded with a **stale file lock**
  (`.lck` held by a live process), and `services.gradle.org`/`downloads.gradle.org` redirect to blocked
  github. Workaround used: `https://mirrors.cloud.tencent.com/gradle/gradle-9.2.1-bin.zip` →
  `spikes/tools/gradle-9.2.1`.
- Resolving the variant classpath makes AGP **install SDK components as a side effect** (it installed
  NDK 29.0.14206865 and build-tools 35 during the termux run). Sync mutating the user's SDK must be
  documented/expected.
- `termux-app-master` **cannot be fully built here**: `:app:downloadBootstraps` fetches
  `bootstrap-*.zip` from github (blocked) and its failure deletes previously valid local zips, which then
  breaks `:app:debugCompileClasspath` resolution. `:app:compileDebugJavaWithJavac -x :app:downloadBootstraps`
  does still produce `R.jar` + `BuildConfig.java`.

## Design deltas (settled plan → reality)

| Was | Now |
|---|---|
| Bundle Vineflower + virtual documents | Use JDT's built-in FernFlower; nothing to build |
| Flatten to invisible project if S1 fails | S1 passed; per-module `.project` model, no flattening |
| Classpath via reflective `androidComponents` | Legacy `variant.getCompileConfiguration()` is the only one-call complete classpath on AGP 8; `androidComponents` needs 2 artifact views + own-R.jar handling |
| Dump task can run standalone | Dump task must `dependsOn compile<Variant>JavaWithJavac` in the same build |
| `java.jar` + AAR jars as `.classpath` libs | Sibling module build outputs must become Eclipse **project references** |
| Two-phase sync then dump | One build+model invocation; "sync" is a compile |

## Open questions

1. Legacy API (complete, AGP 8 only) vs androidComponents + own-R.jar discovery (AGP 8/9, more code).
2. `termux-app-master` is unusable as the acceptance target on this machine (github blocked, bootstrap
   zips deleted) — need another target or a network fix.

---

# S3 — end-to-end on a real project (PASS)

Termux `.project`/`.classpath` files emitted from the model, then probed with `spikes/jdtls-probe2.mjs`:

```
definition on TextView (app/src/main/java/.../TermuxSessionsListViewController.java:52) ->
  jdt://contents/android.jar/android.widget/TextView.java?=ani-terminal-view/...android-36\android.jar<android.widget(TextView.class
  scheme: jdt:   diagnostics: (clean)

definition on TerminalSession (same file) ->
  file:///.../terminal-emulator/src/main/java/com/termux/terminal/TerminalSession.java
  scheme: file:  diagnostics: (clean)
```

So: platform classes resolve into the decompiled `android.jar`, project classes resolve to *source* in a
sibling module, and the workspace has no unresolved imports.

## Facts that cost the most time

1. **`extendedClientCapabilities.classFileContentsSupport: true` is mandatory** in `initialize`.
   Without it JDT LS answers `textDocument/definition` with `[]` for anything inside a jar. Every probe
   that "failed" before this was the harness, not the design.
2. **`android.jar` works as a plain `kind="lib"` entry next to a JRE container** — no duplicate
   platform-class errors, definitions decompile correctly. (Earlier suspicion that JDT drops
   "JRE-looking" jars was wrong; the failure was a malformed test jar.)
3. **A jar built by Python `zipfile` without directory entries is invisible to JDT** (hover empty,
   symbols 0) while the same classes packed with `jar cf` resolve fine. Do not test with ad-hoc zips.
4. **The javac task's own classpath is the reliable classpath source**:
   `variant.javaCompileProvider.get().classpath.files` is complete (own `R.jar`, sibling `classes.jar`,
   AAR jars, boot classpath jars not included) and unambiguous. `getCompileConfiguration().resolve()`
   throws `ArtifactSelectionException` *when the compile tasks run in the same build* — which is
   exactly our situation, since the dump must depend on them.
5. **Generated source dirs only via `androidComponents.sources.java.all`**, resolved inside the dump
   task after compile. Legacy `variant.getSourceFolders()` throws
   `EvalIssueException: Unknown SourceKind value: null` on AGP 8.13.
6. `bootClasspath` must be merged into the `.classpath` libs; the Gradle model keeps it separate and
   omitting it produces a wall of "cannot be resolved" errors for every `android.*` import.
7. Absolute lib paths must keep Windows separators (`C:\Users\...`) to be byte-identical to what
   Eclipse writes; `path.relative` across drives returns an absolute path, which silently turned
   `C:\...` into a bogus relative-ish `C:/...` entry.

## Implemented (this folder)

```
package.json                      activation on settings.gradle(.kts), 3 commands
src/extension.ts                  activation, sync orchestration, live status bar, cancel command, Output channel
src/gradle.ts                     wrapper discovery + `--init-script ... androidNaviModel` runner
src/model.ts                      planModel/writePlan: .project + .classpath emission, .git/info/exclude
src/settings.ts                   window-scoped java.* settings at workspace scope, tracked and reverted
src/types.ts                      model JSON types
gradle/android-navi-model.gradle  the init script (validated on termux, all 8 variants)
spikes/                           throwaway harnesses, fixtures, and the emitter-equivalence check
```

`spikes/compare-emitter.cjs` asserts the TypeScript emitter reproduces, entry for entry, the
`.classpath` files that produced the working navigation above — currently `identical: true` for all
four modules.

Unverified so far: the auto-import code action end-to-end, and the extension running inside VS Code
(only its pieces and the JDT LS interaction behind it are verified).

# S4 — auto-import (PASS)

`spikes/import-probe.mjs`: a file referencing `TextView` with no import, on the generated classpath.

```
diagnostics: TextView cannot be resolved to a type
code actions: Create class ... | Organize imports [source.organizeImports] | Add all missing imports [source] | ...
import edit : range 0:14-2:0 -> "\n\nimport android.widget.TextView;\n\n"
```

JDT does not surface a per-symbol "Import 'X'" quickfix here; it offers `source.organizeImports` and
`source` → "Add all missing imports", both of which resolve on our classpath and edit the file. That
satisfies the auto-import acceptance item, but the UX is VS Code's source-action menu, not Android
Studio's Alt+Enter list.

# Regression harness

`npm run verify` (config in `verify.config.json`) does what the extension does, headless:

```
[1/3] gradlew --init-script gradle/android-navi-model.gradle --no-configuration-cache -q androidNaviModel
[2/3] emitting .project/.classpath (variant debug)   -> 4 modules, 8 files
[3/3] JDT LS probes
PASS  no variant reported a classpath error
PASS  no foreign .project conflicts
PASS  every classpath entry exists on disk — 0 missing
PASS  model covers at least one module — 4 modules
PASS  android.jar definition (platform class) — jdt://contents/android.jar/android.widget/TextView.java
PASS  android.jar definition (platform class): no error diagnostics
PASS  cross-module definition (project class to source) — file:///.../terminal-emulator/src/main/java/...
7/7 checks passed
```

Run point is chosen in `verify.config.json` (`file`/`line`/`char`/`expect`), so a second project needs only
a new config. The JDT LS workspace data dir is reused (`out/verify-jdtls`) — delete it to test a cold start.

`F5` in this folder launches an Extension Development Host against a prompt-specified Android project
(`.vscode/launch.json`), which is the only path that exercises the real VS Code wiring.

# S5 — first real-world report: "Ctrl-click works on line 206 but not line 34"

Symptom: in `app/src/main/java/com/termux/app/TermuxActivity.java`, Ctrl-click on the **usage**
(`ReportActivity.deleteReportInfoFilesOlderThanXDays`, line 206) navigates, but Ctrl-click on the
**import** (`import com.termux.shared.activities.ReportActivity;`, line 34) does nothing.

Diagnosis (from the user's own VS Code state, not guesses):

- `%APPDATA%/Code/User/workspaceStorage/<hash>/redhat.java/jdt_ws/.metadata/.../.projects/`
  contained `app`, `terminal-emulator`, `terminal-view`, `termux-shared`, `termux-app-master`,
  `jdt.ls-java-project` — **no `ani-*` projects**. The window was not running this extension, so
  `java.import.gradle.enabled=false` had never been applied and `redhat.java`'s Gradle importer claimed
  the workspace.
- JDT LS log: `100 problems reported for /TermuxActivity.java` (AGP classpath not resolvable that way).
- `The project: ani-terminal-emulator which is referenced by the classpath, does not exist.` — our
  `.classpath` was read by a project whose referenced `ani-*` projects were never imported.
- The harness proves JDT itself handles *both* positions fine on our model:
  definition at line 34 (import) → `file:///.../termux-shared/src/main/java/.../ReportActivity.java`,
  only deprecation warnings. So the bug was environment, not model.

Two root causes, both now handled:

1. **Running JDT without our settings** gives silently half-working navigation: Buildship still wires
   `app → termux-shared` as a project dependency (so member access resolves) while the type roots are
   broken (so the import does not). Half-broken is worse than broken; the extension must be the thing
   that starts JDT, not an afterthought.
2. **Applying `java.import.gradle.enabled=false` does not retroactively drop Gradle-imported projects.**
   They persist in the JDT workspace metadata and keep answering some queries. Only a clean JDT
   workspace re-imports our `.project` files.

Fix shipped: `applyJavaSettings` now reports whether it flipped the Gradle importer; on the first such
sync `ensureJavaReimport()` asks `java.execute.workspaceCommand('java.project.getAll')` for the project
list, and if any project is not `ani-*` it offers **"Clean Java workspace and reload"**
(`java.clean.workspace`). A fresh JDT workspace is exactly what `npm run verify` exercises, so the
post-clean state is the verified-good state.

# S6 — "Android Navi: syncing…" forever (root cause: settings were written at the wrong scope)

Report: status bar sat at `$(sync~spin) Android Navi: syncing…` indefinitely; no Gradle process was
running and the Android Navi output channel was empty.

Diagnosis (from `%APPDATA%/Code/logs/<session>/window*/exthost/exthost.log`, extension dev host on
`termux-app-master`), 1.2 s after activation:

```
[warning] [local.android-navi] Accessing a window scoped configuration for a resource is not expected.
          To associate 'java.import.gradle.enabled' to a resource, define its scope to 'resource' ...
[error]   CodeExpectedError: Unable to write to Folder Settings because java.import.gradle.enabled
          does not support the folder resource scope.
          at ... PGi.writeConfigurationValue ... at async PGi.updateValue
```

`redhat.java` declares `java.import.gradle.enabled`, `java.import.maven.enabled` and
`java.configuration.updateBuildConfiguration` as `"scope": "window"` — JDT LS is one server per
window, so there is no per-folder value. `applyJavaSettings` wrote them with
`ConfigurationTarget.WorkspaceFolder`, VS Code rejected the write, the rejection escaped `syncAll`
(no `catch`), and the only thing that ever ran was `setStatus('syncing')`. Gradle was never started.

Secondary traps that could produce the same "stuck at syncing" symptom, all closed:

1. `ensureJavaReimport()` was awaited **before** the final `setStatus(...)`. Its
   `showInformationMessage` waits for the user, so a finished sync stayed "syncing…" until the
   notification was answered. The prompt now runs after the status is final and is not awaited.
2. No timeout and no cancellation: a wedged Gradle or a JDT command that never answers could hold
   the promise forever. `androidNavi.gradleTimeoutMinutes` (default 20) stops the build,
   `androidNavi.cancelSync` / clicking the status bar cancels, and JDT commands are bounded at 20 s.
3. `-q` suppressed every `> Task :app:compileDebugJavaWithJavac` line, so a long first compile was
   indistinguishable from a hang. The sync now runs `--console=plain`, and the status bar shows an
   elapsed clock plus the current Gradle task.
4. `spawn(..., { shell: true })` with an args array is joined with spaces by Node, so a wrapper,
   init script or `extraGradleArgs` value containing spaces arrived split. Every argument is now
   shell-quoted (verified with a wrapper and init script under `.../navi test/...`).
5. `child.kill()` only killed `cmd.exe` on Windows, leaving the Gradle client and its build lock
   alive; cancellation/timeout now use `taskkill /pid <pid> /T /F`.
6. Invoking the sync command while one was running silently did nothing; it now offers to cancel.

Settings now go to `ConfigurationTarget.Workspace` (the narrowest scope that accepts window-scoped
keys: `.vscode/settings.json` for a single folder, the `.code-workspace` file for multi-root). A
read-only settings file no longer aborts the sync — the failure is logged and reported in the status
instead. `restoreJavaSettings` puts back a pre-existing workspace value rather than deleting it.

They are also **no longer reverted in `deactivate`**. `redhat.java` activates before this extension
(it is an `extensionDependency`) and starts JDT LS immediately, so reverting on every window close
meant the next window's JDT LS imported the workspace with the Gradle importer enabled again — the
"clean Java workspace and reload" step could never converge. The workspace setting now survives
reloads, JDT LS starts with the importer already disabled, imports the `ani-*` projects, and
`ensureJavaReimport` finds nothing foreign. **"Android Navi: Restore Java Settings"** reverts the
values before uninstalling.

/** Shape of `build/android-navi-model.json`, produced by gradle/android-navi-model.gradle. */
export interface ProjectRef {
  /** Gradle project path, e.g. `:app`. */
  project: string;
  /** The sibling build output that was on the classpath (kept for diagnostics only). */
  file: string;
}

export interface ModelEntry {
  project: string;
  variant: string;
  moduleDir: string;
  buildType?: string;
  bootClasspath?: string[];
  libs?: string[];
  projectRefs?: ProjectRef[];
  sourceDirs?: string[];
  classpathSource?: string;
  compileClasspathError?: string;
  generatedSourcesError?: string;
  sourceSetsError?: string;
  bootClasspathError?: string;
}

export interface Model {
  generatedAt: string;
  gradle: string;
  entries: ModelEntry[];
}

import path from 'node:path';
import { app } from 'electron';

/**
 * Where the app's bundled read-only files live.
 * Packaged: <App>.app/Contents/Resources (electron-builder extraResources).
 * Dev: the package root (packages/app), where resources/ and python/ sit.
 */
function resolveBundledRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return app.getAppPath();
}

let bundledRootCache: string | null = null;

export function bundledRoot(): string {
  if (bundledRootCache === null) bundledRootCache = resolveBundledRoot();
  return bundledRootCache;
}

export const bundledResourcesDir = (): string => path.join(bundledRoot(), 'resources');
export const bundledPythonDir = (): string => path.join(bundledRoot(), 'python');
export const bundledTranscribeScript = (): string =>
  path.join(bundledRoot(), 'python', 'transcribe.py');
export const bundledCalendarScript = (): string =>
  path.join(bundledRoot(), 'python', 'calendar_pdf.py');
export const bundledMaterialsScript = (): string =>
  path.join(bundledRoot(), 'python', 'materials_extract.py');
export const bundledRequirementsFile = (): string =>
  path.join(bundledRoot(), 'python', 'requirements.txt');

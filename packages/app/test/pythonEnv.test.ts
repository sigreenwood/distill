import { describe, it, expect, vi } from 'vitest';

// pythonEnv reaches bundledResources, which imports electron; nothing
// under test touches it.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '' } }));

import { describeImportFailure, IMPORT_CHECK_TIMEOUT_MS } from '../src/main/pythonEnv.js';

describe('describeImportFailure', () => {
  it('names a timeout as a timeout, not a missing package', () => {
    const err = Object.assign(new Error('spawnSync python ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(describeImportFailure({ status: null, signal: 'SIGTERM', error: err })).toBe(
      `import check timed out after ${IMPORT_CHECK_TIMEOUT_MS / 1000}s`,
    );
  });

  it('reports the last stderr line of a failed import', () => {
    const stderr = 'Traceback (most recent call last):\n  File "<string>", line 1\nModuleNotFoundError: No module named \'onnxruntime\'\n';
    expect(describeImportFailure({ status: 1, stderr })).toBe(
      "import failed: ModuleNotFoundError: No module named 'onnxruntime'",
    );
  });

  it('falls back to the exit code when there is no stderr', () => {
    expect(describeImportFailure({ status: 3, stderr: '' })).toBe('import exited 3');
  });
});

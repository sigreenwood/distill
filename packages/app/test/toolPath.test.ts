import { describe, it, expect } from 'vitest';
import { withToolDirs } from '../src/main/toolPath.js';

describe('withToolDirs', () => {
  it("adds Homebrew to launchd's minimal PATH", () => {
    expect(withToolDirs('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(
      '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
    );
  });

  it('leaves an existing order alone and does not duplicate', () => {
    expect(withToolDirs('/opt/homebrew/bin:/usr/bin:/usr/local/bin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/usr/local/bin',
    );
  });

  it('copes with an unset PATH', () => {
    expect(withToolDirs(undefined)).toBe('/opt/homebrew/bin:/usr/local/bin');
  });
});

import { describe, expect, test } from 'bun:test';
import { assetName, isNewer } from './updates';

describe('the updates', () => {
  test('a version is newer number by number, a leading v ignored', () => {
    expect(isNewer('v0.6.0', '0.5.0')).toBe(true);
    expect(isNewer('0.5.10', '0.5.9')).toBe(true);
    expect(isNewer('0.5.0', '0.5.0')).toBe(false);
    expect(isNewer('0.4.9', '0.5.0')).toBe(false);
    expect(isNewer('1.0', '0.9.9')).toBe(true);
  });

  test('each system downloads its own executable', () => {
    expect(assetName('win32', 'x64')).toBe('board-trouble-server-windows-x64.exe');
    expect(assetName('darwin', 'arm64')).toBe('board-trouble-server-macos-arm64');
    expect(assetName('linux', 'x64')).toBe('board-trouble-server-linux-x64');
  });
});

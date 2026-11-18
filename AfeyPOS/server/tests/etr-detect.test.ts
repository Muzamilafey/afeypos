import { describe, expect, it } from 'vitest';
import { detectEtr, type DetectDeps } from '../src/modules/etims/detect.js';

/** A Windows till computer with an ETR program, its folders and the device on COM3. */
function windowsPc(over: Partial<DetectDeps> = {}): DetectDeps {
  const dirs: Record<string, string[]> = {
    'C:\\': ['ETR', 'Windows', 'Users'],
    'C:\\ETR': ['IN', 'OUT', 'logs'],
    'C:\\Program Files': ['Tremol', 'Google'],
    'C:\\Program Files\\Tremol': ['ZFPLab'],
  };
  return {
    platform: 'win32',
    run: async (_cmd, args) => {
      const script = args.join(' ');
      if (script.startsWith('-NoProfile -NonInteractive -Command Get-Process')) return JSON.stringify([{ Name: 'ZFPLabServer', Id: 1200, Path: 'C:\\Program Files\\Tremol\\ZFPLab\\ZFPLabServer.exe' }, { Name: 'node', Id: 900 }, { Name: 'chrome', Id: 50 }]);
      if (script.includes('Uninstall')) return JSON.stringify([{ DisplayName: 'Tremol ZFPLab Server', InstallLocation: 'C:\\Program Files\\Tremol\\ZFPLab' }, { DisplayName: 'Google Chrome' }]);
      if (script.includes('Get-NetTCPConnection')) return JSON.stringify([{ LocalPort: 4444, OwningProcess: 1200 }, { LocalPort: 9999, OwningProcess: 900 }]);
      if (script.includes('Win32_PnPEntity')) return JSON.stringify({ Name: 'Tremol Fiscal Device (COM3)', Manufacturer: 'Tremol' });
      return '';
    },
    listDirs: (p) => dirs[p] ?? [],
    probe: async (url) => url === 'http://127.0.0.1:4444',
    ...over,
  };
}

describe('finding the ETR on this computer', () => {
  it('lists the ETR program and the address it answers on first, then its folders, the program and the device', async () => {
    const { candidates, programs } = await detectEtr(windowsPc());
    expect(candidates[0]).toMatchObject({ kind: 'http', url: 'http://127.0.0.1:4444', name: 'ZFPLabServer', answers: true });
    expect(candidates.find((c) => c.kind === 'folder')).toMatchObject({ inbox: 'C:\\ETR\\IN', outbox: 'C:\\ETR\\OUT' });
    expect(candidates.some((c) => c.kind === 'program' && c.name === 'Tremol ZFPLab Server')).toBe(true);
    expect(candidates.find((c) => c.kind === 'device')).toMatchObject({ name: 'Tremol Fiscal Device (COM3)', detail: 'Tremol · looks like an ETR' });
    expect(programs).toContain('ZFPLabServer');
    // Afey POS itself (port 9999) and other programs are not offered.
    expect(candidates.some((c) => c.port === 9999 || c.name === 'chrome')).toBe(false);
  });

  it('on a computer without an ETR it finds nothing to use, and says so', async () => {
    const empty = windowsPc({ run: async () => '[]', listDirs: () => [], probe: async () => false });
    expect((await detectEtr(empty)).candidates).toEqual([]);
  });
});

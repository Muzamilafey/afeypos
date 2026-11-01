import { describe, expect, it } from 'vitest';
import { bridgeInstallerCmd } from './bridge';

describe('the bridge installer for a till', () => {
  it('is a Windows .cmd with this Afey POS address filled in, asking for administrator rights once', () => {
    const cmd = bridgeInstallerCmd('https://walalaha.afey.co.ke');
    expect(cmd.split('\r\n')[0]).toBe('@echo off');
    expect(cmd).toContain("Start-Process -FilePath '%~f0' -Verb RunAs");
    expect(cmd).toContain("Invoke-RestMethod 'https://walalaha.afey.co.ke/api/v1/public/bridge/install.ps1'");
    expect(cmd).toContain("-ServerUrl 'https://walalaha.afey.co.ke' -SourceUrl 'https://walalaha.afey.co.ke/api/v1/public/bridge/files'");
    // One PowerShell command line: no unescaped double quote inside it.
    const psLine = cmd.split('\r\n').find((l) => l.startsWith('powershell -NoProfile -ExecutionPolicy'))!;
    expect(psLine.slice(psLine.indexOf('"') + 1, psLine.lastIndexOf('"'))).not.toMatch(/(?<!\\)"/);
  });
});

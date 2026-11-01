
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/claude/determined-maxwell-1zzhxx/AfeyPOS/installer/windows/install-online.ps1))) `
  -Mode branch `
  -Port 9999 `
  -HqUrl https://walalaha.afey.co.ke `
  -BranchCode WLH01 `
  -SyncToken '<long token from step 1>' `
  -EncryptionKey 'mCmmJonywDZNXQtgSDPRzJKQOUoS2Lx0kEpv+6nSP9o=' `
  -Ref claude/determined-maxwell-1zzhxx

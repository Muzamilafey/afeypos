& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1))) `
  -Mode branch `
  -Port 9999 `
  -HqUrl https://walalaha.afey.co.ke `
  -BranchCode MAIN `
  -SyncToken 'hzyx26AooUbAQe6Wqds41-SxYE5pwIH1EFAGmBt0TpU' `
  -EncryptionKey '<ENCRYPTION_KEY from Step 1>'

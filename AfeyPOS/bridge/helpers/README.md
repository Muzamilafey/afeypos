# Fingerprint helpers

Vendor SDKs for fingerprint readers are Windows libraries. The Afey device bridge talks to them through a small helper program speaking JSON lines on stdin/stdout (protocol in `src/adapters/fingerprint.ts`).

| Folder | Reader | SDK | Status |
|---|---|---|---|
| `zkfinger/` | ZKTeco ZK4500, ZK9500, SLK20R and other ZKFinger readers | ZKFinger SDK 5.x for Windows (`libzkfpcsharp.dll`) | Source provided; **not compiled or tested** in this build |

Build `zkfinger` on Windows with the .NET SDK: copy `libzkfpcsharp.dll` from the ZKFinger SDK into the folder, install the reader driver, then `dotnet build -c Release`. Point the bridge at it in `config.json`:

```json
"fingerprint": { "vendor": "zkteco", "options": { "helperPath": "C:\\AfeyBridge\\helpers\\zkfinger\\bin\\Release\\net48\\AfeyZkFinger.exe" } }
```

Any other reader works the same way: write a helper that answers `status`, `capture` (with `enroll`), `match` and `identify`, and set `"vendor": "helper"`. `tests/fixtures/fake-helper.mjs` is a minimal example used by the automated tests.

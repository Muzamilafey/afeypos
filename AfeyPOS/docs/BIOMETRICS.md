# Fingerprint and biometric integration (optional)

Afey POS works without any reader: PIN and password sign-in and supervisor approval are always available.

## Design

- Fingerprint **images are never sent or stored**. The reader SDK extracts a vendor *template*; Afey POS stores it encrypted (AES-256-GCM, bound to the user id) in `biometrictemplates`.
- Matching happens on the till PC inside the vendor SDK (1:1 against the selected user's templates), driven by the device bridge.
- Each reader is registered in Afey POS (`POST /biometrics/devices`) and receives a device key (shown once). The bridge signs every call with HMAC-SHA256.
- Verification flow: bridge → `POST /biometrics/challenge` (signed, ±60 s) → server returns a single-use nonce and the user's templates → bridge captures and matches locally → `POST /biometrics/verify` with a signed result → server returns a login token, a single-use supervisor override token, or records attendance.
- Every enrolment, successful and failed verification is written to the audit trail (without template data).
- Templates can be deleted per user (`DELETE /biometrics/templates/:userId`); remove them when an employee leaves. Enable the `biometrics` module only after informing employees and obtaining consent.

## Kenyan data protection

Biometric data is *sensitive personal data* under the Kenya Data Protection Act, 2019. Before enabling: register as a data controller with the ODPC where required, document the purpose (cashier verification/attendance), obtain explicit consent, carry out a Data Protection Impact Assessment, limit retention, and provide the PIN alternative. Back up `ENCRYPTION_KEY` securely; templates are useless without it.

## Supported readers

| Vendor | SDK | Status |
|---|---|---|
| Simulator | built in | Implemented and tested end-to-end (server + bridge) |
| ZKTeco (e.g. ZK4500, ZK9500, SLK20R) | ZKFinger SDK for Windows (licensed separately) | Adapter interface only; returns "SDK not installed" |
| SecuGen (e.g. Hamster Pro 20) | SecuGen FDx SDK Pro for Windows | Adapter interface only |

To integrate a real reader: identify the exact model, obtain and license the SDK, install its driver, then implement `FingerprintAdapter` (`bridge/src/adapters/fingerprint.ts`): `status()`, `capture()` returning a base64 template and format, and `match()`. The SDKs are Windows DLLs, so the usual approach is a small helper executable (C#) called by the bridge over stdin/stdout. This has **not been done or tested** in this build.

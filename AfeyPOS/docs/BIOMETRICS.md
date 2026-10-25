# Staff cards, fingerprint readers and clocking in

Staff can sign in, approve supervisor actions and clock in or out four ways. Password and PIN always work, so no hardware is required.

| Method | Sign in | Supervisor approval | Clock in / out |
|---|---|---|---|
| Email + password (+ 2-step code) | yes | yes | — |
| Email + till PIN | yes | yes | — |
| **Staff card** (barcode) + PIN | yes | yes | yes, from the sign-in screen |
| **Fingerprint** (touch only) | yes | yes | yes |

## Staff ID cards

- *Users → (employee) → Issue card* prints a CR80 (credit-card size, 85.6 × 54 mm) card with the business name, employee name, job title, employee number (`EMP-0001`) and a Code 128 barcode. Print it on a card printer, or on paper and laminate it. *Print card* reprints the same card.
- The barcode holds a random code (`AFE` + 13 characters, 65 bits). The server keeps only its SHA-256 (for lookup) and an encrypted copy (for reprints); the code is never shown in lists or logs.
- Any USB or Bluetooth scanner in keyboard mode works: on the sign-in screen choose **Staff card**, scan, type the PIN.
- **PIN with the card** is on by default (*Settings → Business → Staff cards also need the PIN*). A barcode can be photocopied, so card-only sign-in is only advisable where the till is supervised.
- Five wrong PINs lock the account for 15 minutes. Staff with 2-step verification must sign in with their password.
- *Issue new card* voids the old card at once; *Revoke* stops the card without issuing a new one. Disable the user when someone leaves.
- Managers set or reset an employee's PIN from the same screen.

## Fingerprint readers

- Fingerprint **images are never sent or stored**. The reader SDK extracts a vendor *template*; Afey POS stores it encrypted (AES-256-GCM, bound to the user id).
- Matching runs on the till PC inside the vendor SDK, driven by the **Afey device bridge**:
  - **1:N identification**: the employee just touches the reader. The server hands the reader the templates of the active staff allowed at the reader's branch (up to 500), and the reader says who matched.
  - **1:1 verification** of a named person (by email) is also supported.
- Every call from the bridge is signed with the reader's device key (HMAC-SHA256). Each verification uses a single-use 60-second nonce. For identification the signature also covers the matched user, and the server accepts only a user who was offered to that reader.
- Every enrolment and every successful or failed verification goes to the audit trail, without template data.

### Setting up a till

1. Install the reader driver and the device bridge on the till PC (see HARDWARE.md). For ZKTeco readers, build the helper in `bridge/helpers/zkfinger` with the ZKFinger SDK (see `bridge/helpers/README.md`) and set `"fingerprint": { "vendor": "zkteco", "options": { "helperPath": "…\\AfeyZkFinger.exe" } }`.
2. *Hardware → Fingerprint readers → Register reader*. Copy the `biometricDevice` block shown (the key is shown once) into the bridge's `config.json` and restart the bridge.
3. On the till, *Hardware → This computer*: enter the bridge address (`http://127.0.0.1:9123`) and its pairing token, then press *Test connection*. It should report *Reader registered* and the reader *ready*.
4. *Users → (employee) → Enrol finger* on that till. Some readers ask for three presses. Enrol two fingers per person, so a cut finger doesn't lock them out.
5. Enable the **Biometrics** module (*Settings → Modules*) once employees have been informed and have consented (see below).

The web app talks to the bridge only on the PC's own loopback address; the page's security policy allows `http://127.0.0.1:*` and `http://localhost:*` and nothing else.

### Supported readers

| Reader | How | Status |
|---|---|---|
| Simulator | built into the bridge | Tested end to end: enrolment, touch sign-in and fingerprint clocking, in the browser through the real bridge and server |
| ZKTeco ZK4500 / ZK9500 / SLK20R (ZKFinger SDK 5.x) | `bridge/helpers/zkfinger` (C#, .NET Framework 4.8, x86) | Source provided; **not compiled or tested with a real reader** in this build |
| SecuGen Hamster Pro 20, others | write a helper for the same JSON-lines protocol (`"vendor": "helper"`) | Protocol tested with a fake helper |

The helper protocol (`status`, `capture` with `enroll`, `match`, `identify`) is documented in `bridge/src/adapters/fingerprint.ts`.

## Clocking in and out

*Clock in / out* on the sign-in screen accepts a staff card (+ PIN) or a fingerprint, without signing anyone in. Each scan alternates clock in / clock out. Records are listed at `GET /attendance` and are used by HR (attendance and payroll).

## Kenyan data protection

Biometric data is *sensitive personal data* under the Kenya Data Protection Act, 2019. Before enabling fingerprints:
- register as a data controller with the ODPC where required;
- document the purpose (staff sign-in and attendance) and obtain explicit consent;
- carry out a Data Protection Impact Assessment;
- limit retention: delete an employee's fingerprints when they leave (*Users → Delete fingerprints*);
- keep the card/PIN alternative available.

Back up `ENCRYPTION_KEY` securely; templates and card copies are useless without it.

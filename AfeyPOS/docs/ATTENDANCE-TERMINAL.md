# Attendance terminal

The attendance terminal is a web app served by Afey POS at **`/attendance-terminal/`**. It uses the same API and database as the POS. On branch installations it records locally while offline and syncs attendance to head office when the internet returns.

The same build can run as a dedicated local kiosk on **`http://127.0.0.1:5175/`**. This is useful for a computer at the staff entrance and continues working when a branch has no internet.

## Start it

- In Afey POS, open **People → Attendance** and select **Open web attendance terminal** to use the app from the same site as the POS.
- For a dedicated local kiosk, select **Install attendance startup app** and run `AfeyPOS-Attendance.cmd` on the local Afey POS computer. Approve the administrator prompt. The command builds the app if needed, registers the **AfeyPOS Attendance** Windows startup task, starts the local web server, waits for it to answer, and opens it in the browser. It starts again after a device restart and retries if the web server exits.
- The command requires the Afey POS installation, Node.js/npm, and installed workspace dependencies on that computer. It is offered by standalone and branch installations, not the remote HQ server; HQ users can open the hosted web app instead.
- For development, `npm run dev:attendance` starts the Vite app directly. `npm run dev` starts the API, POS, shop and attendance terminal together.
- The local kiosk listens on loopback only. For a network browser, use the hosted `/attendance-terminal/` page through the POS server rather than exposing port 5175.

## Card scanner

USB barcode scanners that type the card code into the focused field and send Enter work without extra software. If **Staff cards also need the PIN** is enabled, the terminal asks for the PIN after reading a card.

## Fingerprint reader

The local launcher reads the pairing token and port from `bridge/config.json` and passes them to the app in a URL fragment. The app saves them to this browser's local storage, removes the fragment immediately, then tests the bridge. The bridge allows the two fixed kiosk origins and the origin of its configured `server.url`. Register the reader in Afey POS under **Hardware → This computer**. If the hosted web app uses a different origin, add that exact origin to the bridge's `allowedOrigins`; pairing tokens remain browser-local.

Fingerprint matches are verified by the registered bridge against the same tenant's enrolled templates, then the existing attendance API records the event. The app does not store fingerprint data.

## Offline and branch sync

The terminal sends clock events to the local Afey API. A branch installation records attendance locally while disconnected; the existing branch sync uploads attendance records to head office when connectivity returns. A standalone installation keeps records in its local database.

## Attendance reporting

The POS **People → Attendance** page shows the clock-in count and rate for every employee linked to a staff login. Rate means distinct days with a clock-in divided by calendar days elapsed in the selected month; the POS does not currently store work schedules or holidays. Hours and payroll days count completed clock-in/clock-out pairs.

## PIN-only sign in

PIN-only login identifies one staff member by a unique PIN within the business. New and changed PINs are indexed using a tenant-scoped keyed digest; the PIN itself remains stored only as a salted password hash. Existing PIN hashes cannot be converted or checked for collisions because their plaintext is not stored. Set or change each existing staff PIN under **Users → Staff access** to enable PIN-only login and establish unique PINs for the whole team. Duplicate PINs among indexed accounts are rejected.

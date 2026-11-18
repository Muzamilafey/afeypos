# Local attendance terminal

The attendance terminal is a local web app on port **5175**. It proxies `/api` to the Afey POS server configured in `server/.env`, so clock events use the same database as the POS.

## Start it

- In Afey POS, open **People → Attendance** and download **Attendance launcher**. Run `AfeyPOS-Attendance.cmd` on the local Afey POS computer. It builds the terminal if needed, starts its production preview at `http://127.0.0.1:5175`, waits until the page responds, then opens it in the browser. Leave the command window open while it is in use; closing that window stops the terminal.
- The launcher requires the Afey POS installation, Node.js/npm, and installed workspace dependencies on that same computer. It is offered by standalone and branch installations, not the remote HQ server.
- For development, `npm run dev:attendance` starts the Vite app directly. `npm run dev` starts the API, POS, shop and attendance terminal together.
- The terminal listens on loopback only and is intended for a browser on the attendance computer.

## Card scanner

USB barcode scanners that type the card code into the focused field and send Enter work without extra software. If **Staff cards also need the PIN** is enabled, the terminal asks for the PIN after reading a card.

## Fingerprint reader

The launcher reads the local pairing token and port from `bridge/config.json` and passes them to the app in a URL fragment. The app saves them to this browser's local storage, removes the fragment immediately, then tests the bridge. Bridge startup automatically allows the two fixed attendance origins (`http://127.0.0.1:5175` and `http://localhost:5175`). Register the reader in Afey POS under **Hardware → This computer**. If the bridge uses a custom config path, open the gear menu and enter its address and pairing token manually.

Fingerprint matches are verified by the registered bridge against the same tenant's enrolled templates, then the existing attendance API records the event. The app does not store fingerprint data.

## Offline and branch sync

The terminal sends clock events to the local Afey API. A branch installation records attendance locally while disconnected; the existing branch sync uploads attendance records to head office when connectivity returns. A standalone installation keeps records in its local database.

## Attendance reporting

The POS **People → Attendance** page shows the clock-in count and rate for every employee linked to a staff login. Rate means distinct days with a clock-in divided by calendar days elapsed in the selected month; the POS does not currently store work schedules or holidays. Hours and payroll days count completed clock-in/clock-out pairs.

## PIN-only sign in

PIN-only login identifies one staff member by a unique PIN within the business. New and changed PINs are indexed using a tenant-scoped keyed digest; the PIN itself remains stored only as a salted password hash. Existing PIN hashes cannot be converted or checked for collisions because their plaintext is not stored. Set or change each existing staff PIN under **Users → Staff access** to enable PIN-only login and establish unique PINs for the whole team. Duplicate PINs among indexed accounts are rejected.

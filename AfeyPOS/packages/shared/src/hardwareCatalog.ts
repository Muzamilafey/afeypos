/**
 * Hardware Compatibility Centre catalogue: what Afey POS can work with, how, and how sure we are.
 *
 * Status rules:
 *   verified       tested end to end with this exact device / software (lastVerified says when)
 *   configurable   works through a documented standard (ESC/POS, ZPL, TSPL, keyboard input, RS-232 weight output)
 *                  once set up; test your own unit before use
 *   driver         needs the maker's driver installed on the PC
 *   sdk            needs the maker's SDK or a provider integration/approval
 *   unverified     expected to work but not tested here
 *   unsupported    not supported
 * No entry claims an untested model is verified, and no maker protocol is invented: devices whose own
 * protocol Afey POS does not speak are listed with the way that does work, or as unsupported.
 */

export const HARDWARE_CATEGORIES = [
  { key: 'barcode_scanner', label: 'Barcode scanners' },
  { key: 'scale', label: 'Weighing scales' },
  { key: 'label_scale', label: 'Label-printing scales' },
  { key: 'receipt_printer', label: 'Receipt printers' },
  { key: 'label_printer', label: 'Label printers' },
  { key: 'cash_drawer', label: 'Cash drawers' },
  { key: 'customer_display', label: 'Customer displays' },
  { key: 'fingerprint_reader', label: 'Fingerprint readers' },
  { key: 'card_terminal', label: 'Card payment terminals' },
  { key: 'other', label: 'Other peripherals' },
] as const;
export type HardwareCategory = (typeof HARDWARE_CATEGORIES)[number]['key'];

export type CompatStatus = 'verified' | 'configurable' | 'driver' | 'sdk' | 'unverified' | 'unsupported';
export const COMPAT_STATUS: Record<CompatStatus, { label: string; tone: 'green' | 'blue' | 'amber' | 'gray' | 'red' }> = {
  verified: { label: 'Verified compatible', tone: 'green' },
  configurable: { label: 'Compatible with configuration', tone: 'blue' },
  driver: { label: 'Requires driver', tone: 'amber' },
  sdk: { label: 'Requires manufacturer SDK', tone: 'amber' },
  unverified: { label: 'Not yet verified', tone: 'gray' },
  unsupported: { label: 'Unsupported', tone: 'red' },
};

export type Connection = 'usb' | 'serial' | 'usb_serial' | 'lan' | 'wifi' | 'bluetooth' | 'keyboard' | 'sdk' | 'bridge' | 'browser' | 'cloud';
export const CONNECTION_LABELS: Record<Connection, string> = {
  usb: 'USB', serial: 'Serial RS-232', usb_serial: 'USB-to-serial', lan: 'Ethernet / LAN', wifi: 'Wi-Fi', bluetooth: 'Bluetooth',
  keyboard: 'Keyboard emulation', sdk: 'Manufacturer SDK', bridge: 'Afey device bridge (local connector)', browser: 'Browser printing', cloud: 'Provider cloud',
};

export interface CompatEntry {
  id: string;
  category: HardwareCategory;
  manufacturer: string;
  model: string;
  connections: Connection[];
  os: string[];
  protocols: string[];
  drivers: string;
  sdk: string;
  operations: string[];
  limitations: string;
  status: CompatStatus;
  docs: string;
  lastVerified: string | null;
  /** Where to set it up in Afey POS. */
  setup: 'device' | 'scales' | 'terminals' | 'fingerprint' | 'display' | 'none';
}

const WIN = ['Windows 10/11'];
const ANY = ['Windows 10/11', 'Linux', 'macOS', 'Android (browser)'];

export const HARDWARE_CATALOG: CompatEntry[] = [
  // ---- barcode scanners ----
  { id: 'scanner-hid', category: 'barcode_scanner', manufacturer: 'Any', model: 'USB / Bluetooth scanner in keyboard (HID) mode', connections: ['usb', 'bluetooth', 'keyboard'], os: ANY, protocols: ['Keyboard emulation'], drivers: 'None (the PC sees a keyboard)', sdk: 'None', operations: ['EAN-13/8, UPC-A/E, Code 128, Code 39, GS1 scale labels', 'Staff cards'], limitations: 'Set the scanner to add Enter after each code and to the keyboard layout of the PC.', status: 'configurable', docs: 'docs/HARDWARE.md', lastVerified: null, setup: 'device' },
  { id: 'honeywell-1250g', category: 'barcode_scanner', manufacturer: 'Honeywell', model: 'Voyager 1250g', connections: ['usb', 'keyboard'], os: ANY, protocols: ['USB HID keyboard'], drivers: 'None in keyboard mode', sdk: 'None', operations: ['1D barcodes'], limitations: '1D only (no QR codes). Keyboard mode with Enter suffix (factory default on most units).', status: 'unverified', docs: 'Honeywell Voyager 1250g user guide', lastVerified: null, setup: 'device' },
  { id: 'zebra-ds2208', category: 'barcode_scanner', manufacturer: 'Zebra', model: 'DS2208', connections: ['usb', 'keyboard'], os: ANY, protocols: ['USB HID keyboard'], drivers: 'None in keyboard mode', sdk: 'None', operations: ['1D and 2D barcodes, screens (M-Pesa codes on phones)'], limitations: 'Keyboard mode with Enter suffix.', status: 'unverified', docs: 'Zebra DS2208 product reference guide', lastVerified: null, setup: 'device' },
  { id: 'datalogic-qd2430', category: 'barcode_scanner', manufacturer: 'Datalogic', model: 'QuickScan QD2430', connections: ['usb', 'keyboard'], os: ANY, protocols: ['USB HID keyboard'], drivers: 'None in keyboard mode', sdk: 'None', operations: ['1D and 2D barcodes'], limitations: 'Keyboard mode with Enter suffix.', status: 'unverified', docs: 'Datalogic QD2430 product reference guide', lastVerified: null, setup: 'device' },
  { id: 'scanner-serial', category: 'barcode_scanner', manufacturer: 'Any', model: 'Scanner in serial / virtual COM mode only', connections: ['serial', 'usb_serial'], os: WIN, protocols: ['Serial text'], drivers: 'Virtual COM driver', sdk: 'None', operations: [], limitations: 'Not read by the till. Switch the scanner to keyboard (HID) mode instead.', status: 'unsupported', docs: 'docs/HARDWARE.md', lastVerified: null, setup: 'none' },

  // ---- weighing scales ----
  { id: 'scale-serial', category: 'scale', manufacturer: 'Any', model: 'Counter scale with RS-232 / USB-serial weight output', connections: ['serial', 'usb_serial', 'bridge'], os: WIN.concat('Linux'), protocols: ['Continuous or on-request ASCII weight lines (e.g. "ST,GS,+ 1.250kg")'], drivers: 'USB-serial adapter driver if used', sdk: 'None', operations: ['Live gross / tare / net weight', 'Stable-weight check', 'Tare with the command from the scale manual'], limitations: 'Output formats differ by model: each scale must pass its test with a known weight before use.', status: 'configurable', docs: 'docs/WEIGHING-SCALES.md', lastVerified: null, setup: 'scales' },
  { id: 'scale-keyboard', category: 'scale', manufacturer: 'Any', model: 'Scale with keyboard (HID) weight output', connections: ['usb', 'keyboard'], os: ANY, protocols: ['Keyboard emulation'], drivers: 'None', sdk: 'None', operations: ['Weight typed into the weigh window on the send key'], limitations: 'No live reading or tare from the till.', status: 'configurable', docs: 'docs/WEIGHING-SCALES.md', lastVerified: null, setup: 'scales' },
  { id: 'cas-counter', category: 'scale', manufacturer: 'CAS', model: 'Counter scales with RS-232 output (e.g. PD-II, ER series)', connections: ['serial', 'usb_serial', 'bridge'], os: WIN, protocols: ['CAS ASCII weight output'], drivers: 'USB-serial adapter driver if used', sdk: 'None', operations: ['Live weight', 'Stable check'], limitations: 'Model-dependent output settings; test with a known weight.', status: 'unverified', docs: 'docs/WEIGHING-SCALES.md', lastVerified: null, setup: 'scales' },
  { id: 'adam-ohaus', category: 'scale', manufacturer: 'Adam Equipment / OHAUS', model: 'Bench scales with RS-232 / USB output', connections: ['serial', 'usb_serial', 'usb', 'keyboard'], os: WIN, protocols: ['ASCII weight output'], drivers: 'USB-serial driver if used', sdk: 'None', operations: ['Live weight'], limitations: 'Weight only; no PLU list.', status: 'unverified', docs: 'docs/WEIGHING-SCALES.md', lastVerified: null, setup: 'scales' },
  { id: 'scale-simulator', category: 'scale', manufacturer: 'Afey', model: 'Scale simulator', connections: ['cloud'], os: ANY, protocols: ['Internal'], drivers: 'None', sdk: 'None', operations: ['Training and automated tests'], limitations: 'Never weighs real sales.', status: 'verified', docs: 'docs/WEIGHING-SCALES.md', lastVerified: '2026-11-02', setup: 'scales' },

  // ---- label-printing scales ----
  { id: 'label-scale-file', category: 'label_scale', manufacturer: 'CAS / DIGI / Avery Berkel / Bizerba / Mettler Toledo / Ishida', model: 'Label-printing scales with the maker\'s PLU software', connections: ['lan', 'serial', 'sdk'], os: WIN, protocols: ['PLU file (CSV) imported with the maker\'s software'], drivers: 'Maker\'s PLU software', sdk: 'Maker\'s software (not Afey)', operations: ['Prices and PLUs sent as a versioned file', 'Labels read at the till by configurable barcode layouts'], limitations: 'Afey POS does not program the scale over the maker\'s network protocol; a person confirms each import.', status: 'configurable', docs: 'docs/WEIGHING-SCALES.md', lastVerified: null, setup: 'scales' },
  { id: 'label-scale-direct', category: 'label_scale', manufacturer: 'DIGI / Bizerba / Ishida / Mettler Toledo', model: 'Direct PLU programming over the scale network protocol', connections: ['lan'], os: WIN, protocols: ['Proprietary'], drivers: '—', sdk: 'Manufacturer SDK and licence', operations: [], limitations: 'Needs the maker\'s SDK and permission; not implemented. Use the PLU file.', status: 'sdk', docs: 'docs/WEIGHING-SCALES.md', lastVerified: null, setup: 'none' },

  // ---- receipt printers ----
  { id: 'escpos-usb', category: 'receipt_printer', manufacturer: 'Epson / Xprinter / Bixolon / Star (ESC/POS mode)', model: '58 / 80 mm thermal printers on USB', connections: ['usb', 'bridge', 'browser'], os: WIN.concat('Linux'), protocols: ['ESC/POS'], drivers: 'Windows printer driver (for spooler printing)', sdk: 'None', operations: ['Receipts, KRA QR code, logo', 'Cash drawer kick'], limitations: 'Direct printing needs the device bridge on that PC; otherwise the browser print window.', status: 'configurable', docs: 'docs/DEVICE-BRIDGE.md', lastVerified: null, setup: 'device' },
  { id: 'escpos-lan', category: 'receipt_printer', manufacturer: 'Epson / Xprinter / Bixolon (ESC/POS mode)', model: 'Thermal printers on Ethernet / Wi-Fi (port 9100)', connections: ['lan', 'wifi', 'bridge'], os: ANY, protocols: ['ESC/POS over raw TCP 9100'], drivers: 'None', sdk: 'None', operations: ['Receipts', 'Cash drawer kick', 'Printing from the shop server'], limitations: 'The online head-office server does not print to shop networks: use the shop server or the device bridge.', status: 'configurable', docs: 'docs/HARDWARE.md', lastVerified: null, setup: 'device' },
  { id: 'epson-tm-t20', category: 'receipt_printer', manufacturer: 'Epson', model: 'TM-T20III / TM-T82', connections: ['usb', 'lan', 'bridge'], os: WIN, protocols: ['ESC/POS'], drivers: 'Epson Advanced Printer Driver (for Windows spooler)', sdk: 'None', operations: ['Receipts', 'Drawer kick'], limitations: 'Test a print before use.', status: 'unverified', docs: 'Epson TM-T20III technical reference', lastVerified: null, setup: 'device' },
  { id: 'printer-gdi', category: 'receipt_printer', manufacturer: 'Any', model: 'Printers without ESC/POS (GDI-only / inkjet)', connections: ['browser'], os: ANY, protocols: ['Browser printing'], drivers: 'Maker\'s driver', sdk: 'None', operations: ['Receipts through the print window'], limitations: 'No direct printing or drawer kick.', status: 'driver', docs: 'docs/HARDWARE.md', lastVerified: null, setup: 'device' },

  // ---- label printers ----
  { id: 'zebra-zpl', category: 'label_printer', manufacturer: 'Zebra', model: 'ZD220 / ZD420 / GK420 (ZPL)', connections: ['usb', 'lan', 'bridge', 'browser'], os: WIN.concat('Linux'), protocols: ['ZPL'], drivers: 'Zebra driver (for spooler printing)', sdk: 'None', operations: ['50 × 30 mm shelf labels with Code 128, unit and price'], limitations: 'Load the label size in the printer settings.', status: 'configurable', docs: 'docs/PRODUCTS-AND-BARCODES.md', lastVerified: null, setup: 'device' },
  { id: 'tspl', category: 'label_printer', manufacturer: 'TSC / Xprinter / Gprinter', model: 'TSPL thermal label printers (e.g. TE200, XP-365B)', connections: ['usb', 'lan', 'bridge', 'browser'], os: WIN.concat('Linux'), protocols: ['TSPL'], drivers: 'Maker\'s driver (for spooler printing)', sdk: 'None', operations: ['Shelf labels'], limitations: 'Calibrate the gap sensor for the label roll.', status: 'configurable', docs: 'docs/PRODUCTS-AND-BARCODES.md', lastVerified: null, setup: 'device' },
  { id: 'label-browser', category: 'label_printer', manufacturer: 'Any', model: 'Any printer through the print window', connections: ['browser'], os: ANY, protocols: ['HTML print'], drivers: 'Printer driver', sdk: 'None', operations: ['Labels from the browser'], limitations: 'Set the paper size to the label in the print window.', status: 'verified', docs: 'docs/PRODUCTS-AND-BARCODES.md', lastVerified: '2026-11-02', setup: 'none' },

  // ---- cash drawers ----
  { id: 'drawer-dk', category: 'cash_drawer', manufacturer: 'Any', model: 'Drawer on the receipt printer\'s DK / RJ11 port (12/24 V)', connections: ['usb', 'lan', 'bridge'], os: ANY, protocols: ['ESC/POS drawer kick (ESC p)'], drivers: 'As the printer', sdk: 'None', operations: ['Opens on cash sales and from More → Open drawer (audited)'], limitations: 'Match the drawer voltage to the printer.', status: 'configurable', docs: 'docs/HARDWARE.md', lastVerified: null, setup: 'device' },
  { id: 'drawer-usb', category: 'cash_drawer', manufacturer: 'Any', model: 'Drawers with their own USB / serial interface', connections: ['usb', 'serial'], os: WIN, protocols: ['Maker-specific'], drivers: 'Maker\'s driver', sdk: 'Maker-specific', operations: [], limitations: 'Not supported: connect the drawer to the receipt printer instead.', status: 'unsupported', docs: 'docs/HARDWARE.md', lastVerified: null, setup: 'none' },

  // ---- customer displays ----
  { id: 'display-screen', category: 'customer_display', manufacturer: 'Afey', model: 'Customer display on a second monitor', connections: ['browser'], os: ANY, protocols: ['Same-PC browser channel'], drivers: 'None', sdk: 'None', operations: ['Items, quantities, prices, discounts, total, payment status, thank-you and change'], limitations: 'Second monitor on the same till PC.', status: 'verified', docs: 'docs/RETAIL-ECOSYSTEM-AUDIT.md', lastVerified: '2026-11-02', setup: 'display' },
  { id: 'display-vfd', category: 'customer_display', manufacturer: 'Epson / generic', model: 'Two-line VFD / LCD pole displays (serial, ESC/POS)', connections: ['serial', 'usb_serial', 'bridge'], os: WIN, protocols: ['ESC/POS display commands'], drivers: 'USB-serial driver if used', sdk: 'None', operations: ['Two lines of 20 characters'], limitations: 'Through the device bridge; test before use.', status: 'configurable', docs: 'docs/DEVICE-BRIDGE.md', lastVerified: null, setup: 'device' },

  // ---- fingerprint readers ----
  { id: 'zk-slk20r', category: 'fingerprint_reader', manufacturer: 'ZKTeco', model: 'SLK20R / ZK9500', connections: ['usb', 'bridge', 'sdk'], os: WIN, protocols: ['ZKFinger SDK'], drivers: 'ZKTeco driver', sdk: 'ZKFinger SDK (from ZKTeco)', operations: ['Enrol, sign in, supervisor approval, attendance'], limitations: 'Needs the SDK helper next to the device bridge.', status: 'sdk', docs: 'docs/BIOMETRICS.md', lastVerified: null, setup: 'fingerprint' },
  { id: 'secugen-hamster', category: 'fingerprint_reader', manufacturer: 'SecuGen', model: 'Hamster Pro 20', connections: ['usb', 'bridge', 'sdk'], os: WIN, protocols: ['SecuGen FDx SDK'], drivers: 'SecuGen driver', sdk: 'SecuGen FDx SDK', operations: ['Enrol, sign in, approval, attendance'], limitations: 'Needs the SDK helper next to the device bridge.', status: 'sdk', docs: 'docs/BIOMETRICS.md', lastVerified: null, setup: 'fingerprint' },

  // ---- card terminals ----
  { id: 'bank-pdq', category: 'card_terminal', manufacturer: 'Kenyan banks (Equity, KCB, Co-op, NCBA…)', model: 'Bank PDQ terminals', connections: ['cloud', 'lan', 'sdk'], os: ANY, protocols: ['Provider integration'], drivers: '—', sdk: 'Bank / provider integration and approval', operations: ['Card payments with verified approval at the till'], limitations: 'Each bank must provide and approve its integration. Without it, record the approval code from a standalone PDQ.', status: 'sdk', docs: 'docs/CARD-TERMINALS.md', lastVerified: null, setup: 'terminals' },
  { id: 'terminal-simulator', category: 'card_terminal', manufacturer: 'Afey', model: 'Terminal simulator', connections: ['cloud'], os: ANY, protocols: ['Internal'], drivers: 'None', sdk: 'None', operations: ['Training and automated tests'], limitations: 'Test payments only.', status: 'verified', docs: 'docs/CARD-TERMINALS.md', lastVerified: '2026-11-02', setup: 'terminals' },

  // ---- other ----
  { id: 'kra-etr', category: 'other', manufacturer: 'KRA-approved ETR makers', model: 'ETR / fiscal device on the server PC', connections: ['usb', 'serial', 'lan', 'sdk'], os: WIN, protocols: ['Maker\'s ETR software / file exchange'], drivers: 'Maker\'s driver', sdk: 'Maker\'s ETR software', operations: ['Receipts signed by the ETR'], limitations: 'Works through the maker\'s software found on the server PC (Settings → KRA ETR).', status: 'sdk', docs: 'docs/KRA-ETR-DEVICE.md', lastVerified: null, setup: 'none' },
];

/** Connections a catalogue entry allows (for the onboarding wizard). */
export const connectionsFor = (id: string): Connection[] => HARDWARE_CATALOG.find((e) => e.id === id)?.connections ?? [];

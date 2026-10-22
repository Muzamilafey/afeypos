/** Minimal ESC/POS command builder for thermal receipt printers (58mm/80mm). */
const ESC = 0x1b;
const GS = 0x1d;

export class EscPosBuilder {
  private chunks: Buffer[] = [];
  constructor(public width = 42) {
    this.raw([ESC, 0x40]); // initialise
  }
  raw(bytes: number[]) {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }
  text(s: string) {
    // Most printers default to CP437/PC850; strip characters they cannot render.
    this.chunks.push(Buffer.from(s.normalize('NFKD').replace(/[^\x20-\x7e\n]/g, ''), 'ascii'));
    return this;
  }
  line(s = '') {
    return this.text(s + '\n');
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw([ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]);
  }
  bold(on: boolean) {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }
  size(double: boolean) {
    return this.raw([GS, 0x21, double ? 0x11 : 0x00]);
  }
  feed(n = 3) {
    return this.raw([ESC, 0x64, n]);
  }
  cut() {
    return this.raw([GS, 0x56, 0x42, 0x00]);
  }
  /** Pulse the cash drawer connected to the printer's DK port. */
  openDrawer(pin: 0 | 1 = 0) {
    return this.raw([ESC, 0x70, pin, 0x19, 0xfa]);
  }
  /** CODE128 barcode. */
  barcode(data: string) {
    const bytes = Buffer.from('{B' + data, 'ascii');
    return this.raw([GS, 0x68, 80, GS, 0x77, 2, GS, 0x48, 2, GS, 0x6b, 73, bytes.length, ...bytes]);
  }
  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

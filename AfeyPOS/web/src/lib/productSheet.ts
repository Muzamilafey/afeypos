/**
 * The product import spreadsheet: a formatted Excel template (header, dropdowns, instructions, room for a photo
 * on each row) and reading a filled one back, photos included. Excel is handled in the browser (exceljs, loaded
 * only on the import page); CSV files from older exports are read too.
 */
import type { Workbook, Worksheet } from 'exceljs';

export interface SheetColumn { key: string; header: string; width: number; note: string; required?: boolean; money?: boolean }
export interface ImportRow { _row: number; values: Record<string, string>; photo?: Blob }

export const COLUMNS = (showCost: boolean): SheetColumn[] => [
  { key: 'image', header: 'Photo', width: 12, note: 'Optional. Insert › Pictures › Place over cells, and drop the picture on this row. Or upload photos named by SKU or barcode on the import page.' },
  { key: 'name', header: 'Product name', width: 34, required: true, note: 'Name shown at the till, on receipts and in the shop, e.g. "Brookside Milk 500ml".' },
  { key: 'sku', header: 'SKU / item code', width: 16, required: true, note: 'Your own code for the product. A row with an SKU that already exists updates that product.' },
  { key: 'barcode', header: 'Barcode', width: 18, note: 'Optional. The number under the barcode on the package (type it or scan it into the cell).' },
  { key: 'category', header: 'Category', width: 20, note: 'Pick from the list or type a new one (it is created).' },
  { key: 'brand', header: 'Brand', width: 16, note: 'Optional. Pick from the list or type a new one.' },
  { key: 'baseUnit', header: 'Unit', width: 9, note: 'How it is sold and counted: pc, kg, l, pkt…' },
  { key: 'type', header: 'Type', width: 12, note: 'Stock item (counted), Service or Non-stock. Leave blank for Stock item.' },
  ...(showCost ? [{ key: 'cost', header: 'Cost price', width: 13, money: true, note: 'What one unit costs you to buy (without VAT you can claim back).' }] : []),
  { key: 'retail', header: 'Selling price', width: 13, required: true, money: true, note: 'Price per unit at the till, including VAT.' },
  { key: 'taxRatePercent', header: 'VAT %', width: 8, note: '16, 8 or 0. Leave blank to use the business default.' },
  { key: 'reorderLevel', header: 'Reorder level', width: 12, note: 'Optional. Shown in Stock alerts when stock falls to this.' },
  { key: 'active', header: 'Active', width: 9, note: 'Yes or No. Leave blank for Yes.' },
  { key: 'description', header: 'Description', width: 36, note: 'Optional. Shown in the online shop.' },
];

const TYPE_LABEL: Record<string, string> = { 'stock item': 'stock', stock: 'stock', service: 'service', 'non-stock': 'non_stock', 'non stock': 'non_stock', non_stock: 'non_stock' };
const NAVY = 'FF1F3B57';
const HEADER_ROW = 3;
const FIRST_ROW = HEADER_ROW + 1;
const ROWS = 1000;

/** Header text (or the old CSV key) → column key. */
function keyFor(header: string, cols: SheetColumn[]): string | undefined {
  const h = header.replace(/\*/g, '').trim().toLowerCase();
  const direct = cols.find((c) => c.header.toLowerCase() === h || c.key.toLowerCase() === h);
  if (direct) return direct.key;
  const alias: Record<string, string> = { name: 'name', 'item name': 'name', 'product': 'name', code: 'sku', 'item code': 'sku', price: 'retail', 'retail price': 'retail', 'selling price': 'retail', cost: 'cost', 'buying price': 'cost', unit: 'baseUnit', 'base unit': 'baseUnit', vat: 'taxRatePercent', 'tax %': 'taxRatePercent', picture: 'image', image: 'image', photo: 'image', wholesale: 'wholesale', contractor: 'contractor' };
  return alias[h];
}

const loadExcel = async () => (await import('exceljs')).default;

export async function buildTemplate(opts: { business: string; showCost: boolean; units: string[]; categories: string[]; brands: string[] }): Promise<Blob> {
  const Excel = await loadExcel();
  const wb: Workbook = new Excel.Workbook();
  wb.creator = 'Afey POS';
  wb.created = new Date();
  const cols = COLUMNS(opts.showCost);
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: 2 }], properties: { defaultRowHeight: 20 } });
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  const last = ws.getColumn(cols.length).letter;

  // Title and a one-line guide above the header.
  ws.mergeCells(`A1:${last}1`);
  Object.assign(ws.getCell('A1'), { value: `${opts.business} · Product import` });
  ws.getCell('A1').font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  ws.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;
  ws.mergeCells(`A2:${last}2`);
  ws.getCell('A2').value = 'One product per row, starting under the blue headings. Columns marked * are required. Hover a heading for help; see the "How to fill" sheet. Then upload this file on Products › Import products.';
  ws.getCell('A2').font = { size: 10, italic: true, color: { argb: 'FF5B6573' } };
  ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F6' } };
  ws.getCell('A2').alignment = { vertical: 'middle', indent: 1, wrapText: true };
  ws.getRow(2).height = 30;

  const head = ws.getRow(HEADER_ROW);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.required ? `${c.header} *` : c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FF0F6E56' : NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: c.money ? 'right' : 'left', wrapText: true, indent: c.money ? 0 : 1 };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF0B1F33' } } };
    cell.note = { texts: [{ text: c.note }], margins: { insetmode: 'auto' } } as any;
  });
  head.height = 32;
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: cols.length } };

  // Lists for the dropdowns live on a hidden sheet (any length, no 255-character limit).
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  const listCols: Record<string, string[]> = {
    baseUnit: opts.units.length ? opts.units : ['pc', 'kg', 'g', 'l', 'ml', 'pkt', 'ctn'],
    category: opts.categories, brand: opts.brands, type: ['Stock item', 'Service', 'Non-stock'], active: ['Yes', 'No'], taxRatePercent: ['16', '8', '0'],
  };
  const listRef: Record<string, string> = {};
  Object.entries(listCols).forEach(([key, values], i) => {
    const col = lists.getColumn(i + 1);
    values.forEach((v, j) => (lists.getCell(j + 1, i + 1).value = v));
    if (values.length) listRef[key] = `Lists!$${col.letter}$1:$${col.letter}$${values.length}`;
  });

  const thin = { style: 'thin' as const, color: { argb: 'FFDDE2E8' } };
  for (let r = FIRST_ROW; r < FIRST_ROW + ROWS; r++) {
    const row = ws.getRow(r);
    row.height = 42;
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
      cell.alignment = { vertical: 'middle', horizontal: c.money ? 'right' : c.key === 'image' ? 'center' : 'left', wrapText: c.key === 'name' || c.key === 'description' };
      if ((r - FIRST_ROW) % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FB' } };
      if (c.money) cell.numFmt = '#,##0.00';
      if (c.key === 'sku' || c.key === 'barcode') cell.numFmt = '@';
      const list = listRef[c.key];
      const strict = c.key === 'type' || c.key === 'active' || c.key === 'baseUnit';
      if (list) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [list], showErrorMessage: strict, errorStyle: strict ? 'stop' : 'information', error: strict ? 'Pick a value from the list.' : undefined };
      else if (c.money || c.key === 'reorderLevel') cell.dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true, showErrorMessage: true, error: 'Enter a number (0 or more).' };
    });
  }

  // How to fill, with an example.
  const help = wb.addWorksheet('How to fill', { properties: { tabColor: { argb: 'FF0F6E56' } } });
  help.columns = [{ width: 22 }, { width: 90 }];
  help.mergeCells('A1:B1');
  help.getCell('A1').value = 'How to fill the product import template';
  help.getCell('A1').font = { size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  help.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  help.getRow(1).height = 28;
  const steps = [
    ['1. One row per product', 'Fill the "Products" sheet from row 4 down. Green headings (*) are required: product name, SKU and selling price.'],
    ['2. Use the lists', 'Unit, type, VAT, category and brand have dropdowns. A category or brand not in the list is created when you import.'],
    ['3. Photos (optional)', 'Click the Photo cell of a row, then Insert › Pictures › Place over Cells. Keep the picture inside that row. Or skip this and upload photos on the import page, named by SKU or barcode (e.g. MILK500.jpg).'],
    ['4. Updating products', 'A row whose SKU already exists updates that product (name, price, barcode…). Stock quantities are not changed: receive stock under Inventory › Receive stock.'],
    ['5. Upload and review', 'Save the file, then Products › Import products › Upload. Every row is checked and shown for review before anything is saved.'],
  ];
  steps.forEach(([a, b], i) => {
    const row = help.getRow(i + 3);
    row.values = [a, b];
    row.getCell(1).font = { bold: true, color: { argb: NAVY } };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.height = 34;
  });
  const ex = help.getRow(steps.length + 5);
  ex.values = ['Example row', 'Brookside Milk 500ml · SKU MILK500 · barcode 6161100600153 · Dairy · Brookside · pc · Stock item · cost 52.00 · price 65.00 · VAT 16 · reorder 24 · Yes'];
  ex.getCell(1).font = { bold: true, color: { argb: NAVY } };
  ex.getCell(2).font = { italic: true, color: { argb: 'FF5B6573' } };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (o.richText) return o.richText.map((t: any) => t.text).join('').trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (o.result !== undefined) return text(o.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v).trim();
};

function readSheet(ws: Worksheet, wb: Workbook, cols: SheetColumn[]): ImportRow[] {
  // The header is the first row with at least two known headings (the template's row 3, a CSV-style row 1…).
  let headerRow = 0;
  const keys: Record<number, string> = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 15) && !headerRow; r++) {
    const found: Record<number, string> = {};
    ws.getRow(r).eachCell((cell, col) => {
      const k = keyFor(text(cell.value), cols);
      if (k) found[col] = k;
    });
    if (Object.values(found).includes('name') && Object.keys(found).length >= 2) {
      headerRow = r;
      Object.assign(keys, found);
    }
  }
  if (!headerRow) throw new Error('No product headings found. Use the Afey POS template (headings: Product name, SKU, Selling price…).');

  const photos = new Map<number, Blob>();
  for (const img of ws.getImages()) {
    const media = wb.getImage(Number(img.imageId)) as any;
    if (!media?.buffer) continue;
    const tl = img.range.tl as any;
    const br = img.range.br as any;
    const middle = br ? (tl.nativeRow + br.nativeRow) / 2 : tl.nativeRow;
    const row = Math.floor(middle) + 1;
    photos.set(row, new Blob([media.buffer], { type: `image/${media.extension === 'jpg' ? 'jpeg' : media.extension}` }));
  }

  const rows: ImportRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const values: Record<string, string> = {};
    const row = ws.getRow(r);
    for (const [col, key] of Object.entries(keys)) if (key !== 'image') values[key] = text(row.getCell(Number(col)).value);
    if (values.type) values.type = TYPE_LABEL[values.type.toLowerCase()] ?? values.type;
    if (!Object.values(values).some(Boolean) && !photos.has(r)) continue;
    rows.push({ _row: r, values, photo: photos.get(r) });
  }
  return rows;
}

function parseCsvText(src: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out;
}

/** Reads the filled template (or a CSV export). */
export async function readProductFile(file: File, showCost: boolean): Promise<ImportRow[]> {
  const cols = COLUMNS(true);
  void showCost;
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    const [head, ...lines] = parseCsvText(await file.text()).filter((r) => r.some((c) => c.trim()));
    if (!head) return [];
    const keys = head.map((h) => keyFor(h, cols));
    if (!keys.includes('name')) throw new Error('No product headings found in the CSV (name, sku, retail…).');
    return lines.map((cells, i) => {
      const values: Record<string, string> = {};
      keys.forEach((k, j) => { if (k && k !== 'image') values[k] = (cells[j] ?? '').trim(); });
      if (values.type) values.type = TYPE_LABEL[values.type.toLowerCase()] ?? values.type;
      return { _row: i + 2, values };
    });
  }
  const Excel = await loadExcel();
  const wb: Workbook = new Excel.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.getWorksheet('Products') ?? wb.worksheets.find((w) => w.state === 'visible');
  if (!ws) throw new Error('The workbook has no sheets');
  return readSheet(ws, wb, cols);
}

/** Shrinks a photo to at most 800 px and JPEG, so it uploads fast and fits the 3 MB limit. */
export async function photoToBase64(blob: Blob): Promise<string> {
  const img = await createImageBitmap(blob);
  const scale = Math.min(1, 800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86).split(',')[1]!;
}

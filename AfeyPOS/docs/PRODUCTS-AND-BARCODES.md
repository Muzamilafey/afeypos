# Products, barcodes and SKUs

## New product wizard

Products → **New product** opens eight short steps. The one-page form is still there (**Use the one-page form**).

1. **Identify:** name, category, brand, type. Products with similar names, and the same barcode or SKU, are
   listed while you type, along with the categories similar products use. These are suggestions from your
   own products. Nothing is filled in unless you choose it. No AI service is used.
2. **Selling method:** by piece, weight, volume, length, area, packs & cartons, several units, or variants.
   This sets the base unit and whether quantities can be fractional.
3. **Units:** the base unit (stock is counted in it) and other units, each defined as a number of base units
   (carton = 24 pc, g = 0.001 kg). Because every unit refers only to the base unit, conversions cannot loop.
   Selling one carton takes 24 pc off stock. Variants (e.g. Size S, M, L × Colour) create one product per
   combination with its own SKU and stock.
4. **Pricing:**
   - cost, retail, wholesale, minimum price, VAT rate, per-unit prices and per-branch prices;
   - margin, markup and profit per unit;
   - target margin or markup with an explicit **Use** button;
   - prices can be typed with or without VAT and are converted to the way the business keeps them;
   - warnings for prices below cost, below the minimum, or with a thin margin. Prices are never changed by
     themselves; saving with an error-level warning needs a tick.
5. **Barcodes & SKU:** scan one or more barcodes (piece, carton). Each shows its format (EAN-13, EAN-8, UPC-A,
   UPC-E, GTIN-14, Code 39, Code 128) and whether its check digit is right. **Suggest** gives the next SKU for the
   category (e.g. `FP-0008`). **Make an in-store barcode** for items without one.
6. **Inventory:** opening stock and store, reorder level and quantity, maximum stock, shelf/bin location, main
   supplier, batch/expiry, serial numbers.
7. **Hardware & labels:** scale PLU (**Next free**, checked for duplicates; `0123` and `123` count as the same),
   label scales, shelf-label copies, price on labels.
8. **Review**, then **Save**.

## Rules enforced by the server

- **Minimum price:** a till price change below a product's minimum needs someone with *Change prices*
  (`prices.manage`), approving on the spot.
- **Branch prices** apply at that branch's tills. They replace the all-branch unit prices there
  (carton = branch price × 24).
- **Changing** the minimum or branch prices needs `prices.manage`.
- **Duplicate PLUs and barcodes** are refused with the name of the product that already has them.

## In-store barcodes

Generated codes are EAN-13 with GS1 prefix **04** (restricted circulation inside one company), with a correct
check digit. They work only in your shops: they are **not GS1-registered GTINs**. For products sold through
other retailers, get GTINs from GS1 Kenya. The prefix can be changed to 02 or 20–29 on the scales page, but
never to one a scale label layout uses.

Branch servers issue Code 128 codes carrying the branch code (`AFYKSM000001`), so two servers can never hand
out the same code.

A UPC-A barcode is found whether the scanner sends 12 digits or 13 (with a leading 0); UPC-E codes are
matched to their UPC-A.

## Products dashboard

The Products page shows tiles for:

- active products;
- products with no barcode;
- products with no price;
- prices below cost;
- weighed products with no PLU;
- low stock.

Click a tile to filter.

Select products to use the bulk actions:

- **Generate barcodes** (skips products that already have one);
- **Assign PLUs**;
- **Move to category**;
- **Archive**;
- **Export**;
- **Preview prices** (± %, rounded to whole shillings).

A price change is previewed first. **Apply these prices** saves only the listed changes, skips any that would go
below cost or the minimum price, and records each change in the audit log.

## API

| Endpoint | Purpose |
|---|---|
| `GET /barcodes/verify?code=` | Format, check digit, in-store flag, scale-label decode, matching products. |
| `POST /barcodes/generate {count}` | In-store codes. |
| `GET /catalog/next-sku?categoryId=` | Next SKU. |
| `GET /catalog/next-plu?check=` | Next PLU. |
| `GET /catalog/similar?name=&barcode=` | Possible duplicates. |
| `GET /catalog/stats` | Dashboard counts. |
| `POST /catalog/bulk {action, productIds, ...}` | Bulk actions. |
| `GET` and `PUT /settings/scale-barcodes` | Scale label layouts. |

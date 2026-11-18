/**
 * A built-in starter list of KRA eTIMS item classification codes (itemClsCd) for common traded goods,
 * so a shop can tag a product with one click instead of hunting through the full code list.
 *
 * KRA's itemClsCd values are derived from the UNSPSC standard (a global product-classification scheme).
 * The codes below are real UNSPSC family/class codes for everyday retail categories. They are a
 * convenience starting point, NOT an authoritative KRA list: every business should confirm the exact
 * code its own eTIMS/VSCU returns from KRA's live classification endpoint before relying on it for
 * filing. Any product may also be given a custom code typed by hand.
 */

export interface EtimsItemClass {
  /** The classification code sent to KRA as itemClsCd. */
  code: string;
  /** A plain-language name for the category. */
  name: string;
  /** The broad group this category sits under (for grouping in the picker). */
  group: string;
  /** Extra words to match when searching (synonyms, local terms). */
  keywords?: string;
}

/**
 * Curated common categories. Codes are UNSPSC family (8-digit) codes. Grouped for a simple picker.
 * Verify against your live KRA eTIMS classification list before filing.
 */
export const ETIMS_ITEM_CLASSES: EtimsItemClass[] = [
  // Food & groceries
  { code: '50180000', name: 'Bread & bakery products', group: 'Food & groceries', keywords: 'bread cake mkate biscuit' },
  { code: '50190000', name: 'Prepared & preserved foods', group: 'Food & groceries', keywords: 'canned tinned snacks' },
  { code: '50200000', name: 'Drinks (soft drinks, juice, water)', group: 'Food & groceries', keywords: 'soda juice water maji beverage' },
  { code: '50210000', name: 'Dairy, eggs & substitutes', group: 'Food & groceries', keywords: 'milk maziwa cheese yoghurt eggs' },
  { code: '50220000', name: 'Cereals & grains', group: 'Food & groceries', keywords: 'rice mchele maize unga wheat flour' },
  { code: '50150000', name: 'Edible oils & fats', group: 'Food & groceries', keywords: 'cooking oil mafuta ghee margarine' },
  { code: '50160000', name: 'Chocolate, sugars & sweeteners', group: 'Food & groceries', keywords: 'sugar sukari sweets candy' },
  { code: '50170000', name: 'Seasonings, sauces & condiments', group: 'Food & groceries', keywords: 'salt spices ketchup royco' },
  { code: '50300000', name: 'Fresh fruits', group: 'Food & groceries', keywords: 'matunda banana mango orange' },
  { code: '50400000', name: 'Fresh vegetables', group: 'Food & groceries', keywords: 'mboga tomato onion kale sukuma' },
  { code: '50120000', name: 'Meat & poultry', group: 'Food & groceries', keywords: 'nyama beef chicken kuku mutton' },
  { code: '50130000', name: 'Fish & seafood', group: 'Food & groceries', keywords: 'samaki omena tilapia' },
  { code: '50201700', name: 'Coffee & tea', group: 'Food & groceries', keywords: 'chai kahawa' },

  // Household & cleaning
  { code: '47130000', name: 'Cleaning supplies', group: 'Household & cleaning', keywords: 'detergent soap omo sabuni bleach jik' },
  { code: '52100000', name: 'Household goods (kitchenware, storage)', group: 'Household & cleaning', keywords: 'sufuria plates cups utensils' },
  { code: '14110000', name: 'Paper products (tissue, towels)', group: 'Household & cleaning', keywords: 'tissue toilet paper napkins' },
  { code: '53131600', name: 'Personal hygiene products', group: 'Household & cleaning', keywords: 'sanitary pads diapers toothpaste' },

  // Health & beauty
  { code: '51100000', name: 'Medicines & drugs', group: 'Health & beauty', keywords: 'dawa panadol tablets pharmacy' },
  { code: '53130000', name: 'Personal care & cosmetics', group: 'Health & beauty', keywords: 'lotion cream shampoo perfume makeup' },
  { code: '42140000', name: 'Medical supplies & first aid', group: 'Health & beauty', keywords: 'bandage gloves mask syringe' },

  // Clothing & textiles
  { code: '53100000', name: 'Clothing', group: 'Clothing & textiles', keywords: 'nguo shirt dress trousers mitumba' },
  { code: '53110000', name: 'Footwear (shoes)', group: 'Clothing & textiles', keywords: 'viatu sandals boots' },
  { code: '53120000', name: 'Bags, luggage & accessories', group: 'Clothing & textiles', keywords: 'handbag belt wallet suitcase' },
  { code: '52120000', name: 'Textiles & fabrics (bedding, towels)', group: 'Clothing & textiles', keywords: 'bedsheet blanket curtain cloth' },

  // Electronics
  { code: '52160000', name: 'Audio & video (TV, radio, speakers)', group: 'Electronics', keywords: 'television tv radio speaker woofer' },
  { code: '43210000', name: 'Computers & accessories', group: 'Electronics', keywords: 'laptop desktop keyboard mouse printer' },
  { code: '43220000', name: 'Phones & communications', group: 'Electronics', keywords: 'phone simu smartphone router airtime' },
  { code: '52140000', name: 'Home appliances', group: 'Electronics', keywords: 'fridge cooker iron blender microwave' },
  { code: '26110000', name: 'Batteries & power (cells, power banks)', group: 'Electronics', keywords: 'battery powerbank charger' },

  // Hardware, building & tools
  { code: '30100000', name: 'Building materials (cement, blocks)', group: 'Hardware & building', keywords: 'cement simiti sand ballast blocks' },
  { code: '31160000', name: 'Hardware (nails, bolts, fittings)', group: 'Hardware & building', keywords: 'nails screws hinges misumari' },
  { code: '27110000', name: 'Hand tools', group: 'Hardware & building', keywords: 'hammer spanner screwdriver panga jembe' },
  { code: '27112700', name: 'Power tools', group: 'Hardware & building', keywords: 'drill grinder welding' },
  { code: '31200000', name: 'Paints & coatings', group: 'Hardware & building', keywords: 'paint rangi varnish thinner' },
  { code: '40140000', name: 'Plumbing (pipes, taps, fittings)', group: 'Hardware & building', keywords: 'pipes tap ppr tank' },
  { code: '39120000', name: 'Electrical supplies (cables, sockets)', group: 'Hardware & building', keywords: 'cable wire socket switch bulb' },

  // Stationery & office
  { code: '44120000', name: 'Stationery & office supplies', group: 'Stationery & office', keywords: 'pen book exercise paper file stapler' },
  { code: '60100000', name: 'Books & educational materials', group: 'Stationery & office', keywords: 'textbook revision library' },
  { code: '56100000', name: 'Furniture', group: 'Stationery & office', keywords: 'chair table desk sofa bed meza kiti' },

  // Agriculture
  { code: '10170000', name: 'Fertilizers & plant nutrients', group: 'Agriculture', keywords: 'fertilizer mbolea dap can urea' },
  { code: '10150000', name: 'Seeds & plants', group: 'Agriculture', keywords: 'seeds mbegu seedlings' },
  { code: '10120000', name: 'Animal feed', group: 'Agriculture', keywords: 'feed dairy meal pumba chick mash' },
  { code: '10190000', name: 'Pesticides & agro-chemicals', group: 'Agriculture', keywords: 'pesticide insecticide sumu spray' },

  // Automotive & fuel
  { code: '25170000', name: 'Vehicle parts & accessories', group: 'Automotive & fuel', keywords: 'spare parts tyre tube filter' },
  { code: '15100000', name: 'Fuels & lubricants', group: 'Automotive & fuel', keywords: 'petrol diesel oil grease gas lpg' },

  // General
  { code: '60140000', name: 'Toys & games', group: 'General', keywords: 'toy game ball doll' },
  { code: '14111500', name: 'Printed matter & packaging', group: 'General', keywords: 'carton bag wrapping label' },
  { code: '99000000', name: 'Other goods (uncategorised)', group: 'General', keywords: 'misc general other' },
];

/** Index for quick lookup of a known code's category name. */
const BY_CODE = new Map(ETIMS_ITEM_CLASSES.map((c) => [c.code, c]));

/** The category for a code, if it is one of the built-in ones. */
export function etimsItemClass(code: string | null | undefined): EtimsItemClass | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

/** Search the built-in list by name, group, code or keyword (case-insensitive). */
export function searchEtimsItemClasses(query: string): EtimsItemClass[] {
  const q = query.trim().toLowerCase();
  if (!q) return ETIMS_ITEM_CLASSES;
  return ETIMS_ITEM_CLASSES.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    c.group.toLowerCase().includes(q) ||
    c.code.includes(q) ||
    (c.keywords ?? '').toLowerCase().includes(q),
  );
}

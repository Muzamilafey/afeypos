# Online shop

A separate shopping website (`shop/`) where customers browse, order and pay. Orders arrive in the POS under *Online orders*, where staff accept, pack and hand them over; completing an order turns it into a normal sale, so stock, receipts, eTIMS and the accounts follow automatically. The website and the POS are separate apps: the shop has its own domain name and design, and talks only to the public shop API of the head-office server.

## Setting it up

1. *Settings → Online shop*:
   - open the shop;
   - choose the branch and warehouse that fulfil orders;
   - pickup and/or delivery, delivery areas with fees, free delivery above an amount, and a minimum order;
   - M-Pesa at checkout and/or pay on delivery;
   - the phone that gets an SMS for every new order, the customer-care number, opening hours and a banner message.
2. On each product to sell online, tick *Sell on the online shop*, optionally *Feature on the home page*, and add a description and photos. Prices are the retail prices; availability is the shop warehouse's stock less what open orders have reserved.
   For an offer, enter a *Was price* (the shop shows the saving and lists it under Deals) and optionally a short *Badge* such as "Organic".
3. Design the shop in *Settings → Store studio* (below).
4. Publish the website (below). M-Pesa at checkout uses your Daraja configuration (MPESA.md); SMS updates need the SMS module.

## Store studio

*Settings → Store studio* edits everything the shop website shows, with a live preview of the real shop next to the editor. Changes show in the preview at once; customers see them after **Publish**. *Discard* drops unpublished changes and *Reset* puts one section back to the original design.

| Section | What you change |
|---|---|
| Brand & colours | Logo, tagline, six ready colour themes or your own main / highlight / soft / footer colours, corner style |
| Top bar | Up to four short messages with icons above the header (delivery, returns, payment) |
| Menu | The links under the header (shop paths such as `/shop?sort=new` or full web addresses) |
| Hero | Small heading, title, text, button, picture (a drawn basket is shown without one), background, handwritten note, feature badges |
| Categories | Round category shortcuts with colour, icon or picture; leave empty to show your product categories automatically |
| Product sections | Featured, Deals of the week (products with a was-price), New arrivals, Best sellers (most sold in the last 90 days): on/off and titles |
| Promo banners | Up to four offers with colour, text, button and picture |
| Why shop with us | Up to six reasons with icons |
| Newsletter | Sign-up box; each email becomes a customer with consent to receive offers |
| Footer & social | About text, Facebook / Instagram / TikTok / YouTube / X / Pinterest / WhatsApp, app store links, link columns, copyright |
| Pages | About, Returns, Delivery, FAQ, Contact, Privacy, Terms and your own pages at `/page/<address>` |
| Search engines | Page title and description |
| Payments & address | The shop's web address, and the payment accounts the shop uses (below) |

Pictures are uploaded like product photos and served publicly only once they are used in the published design. Links must start with `/`, `https://`, `mailto:` or `tel:`; colours are `#rrggbb`; the server checks everything before saving.

**The preview** opens the shop at its web address with `?studio=1` and sends the unsaved design to it; only the POS window that opened it can change what it shows, and only in that browser. When the server also hosts the shop (option A below), allow the POS address to show it in a frame with `SHOP_FRAME_ANCESTORS=https://pos.mysupermarket.co.ke` (`CORS_ORIGINS` and `API_PUBLIC_URL` are allowed already). On another host, allow framing by the POS address there, or use the *open in a new window* button, which works without it.

### Shop payment accounts

By default online orders are paid to the same M-Pesa account as the tills. Under *Payments & address* you can choose instead:
- **M-Pesa account for online orders**: any enabled M-Pesa configuration (for example a separate Paybill for the website);
- **Card payments**: a payment gateway with a hosted checkout page (Paystack, Flutterwave and others under *Settings → Integrations*). Customers choose *Card* at checkout, pay on the provider's page and come back to their order page; the payment is confirmed with the provider before the order is accepted, and completing the order uses that payment (method "gateway"). Card payment is offered only while the gateway is enabled. Set the shop web address so customers are sent back to the right place.

Real Paystack / Flutterwave card checkouts have not been verified end to end here; they use the same gateway code as the tills, which was tested with the payment simulator.

## What customers can do

- Browse the home page sections, all products (sort by newest, best selling, price or name; filter by category or offers), categories, and search (name, barcode or SKU), with prices, savings and stock.
- Keep a cart and a wishlist (both stay in their browser); *Account* lists the orders placed from that browser.
- Check out with delivery (area, address) or pickup.
- Pay by **M-Pesa** (an STK prompt on their phone; if it fails they can send it again from the order page), by **card** where a gateway is chosen, or **on delivery / at pickup**.
- Subscribe to the newsletter.
- Optionally agree to SMS offers, which is recorded as marketing consent in the CRM.
- Follow the order on its page, which shows the live status, or look it up with the order number and phone (*Track an order*). They get an SMS at each step.

Customers are matched to an existing customer by phone, or created (source "online shop"), so their online purchases count in the CRM.

## Fulfilling orders (POS → Online orders)

| Step | What happens |
|---|---|
| New | Shown with a notice in the POS (and SMS to the shop's notify number). Stock is reserved. M-Pesa orders appear once paid. |
| Accept → Start packing | Print the **pick list** (tick-box list with the customer and address). |
| Ready for pickup / Out for delivery | The customer gets an SMS. |
| Complete | Choose the till. For pay-on-delivery orders, record what was collected (cash, M-Pesa code, card); paid M-Pesa orders use their payment. The order becomes a sale at the prices the customer was given, plus a "Delivery fee" line. |
| Cancel | Stock is released and the customer is told why. A paid M-Pesa order gets a refund payout prepared under *M-Pesa payouts*, which a second person approves and sends. |

Unpaid M-Pesa orders are cancelled after two hours. A payment received for an online order is kept for that order and is not offered at the tills as an unused M-Pesa payment.

## Publishing the website

The shop is a static site:
- `npm run build -w @afeypos/shop` builds it into `shop/dist`;
- `npm run dev:shop` runs it locally on http://localhost:5174, talking to the local server.

**Option A: same server as head office.** Point a second DNS name at the HQ server and set:

```env
SHOP_DIST_DIR=/opt/afeypos/AfeyPOS/shop/dist
SHOP_HOSTNAMES=shop.mysupermarket.co.ke
```

Add the name to the reverse proxy (Caddy: `shop.mysupermarket.co.ke { reverse_proxy 127.0.0.1:9999 }`). Requests for that name get the shop; the POS stays on its own address.

**Option B: any static host** (Netlify, Vercel, Cloudflare Pages, an nginx box). Build with the HQ address, then upload `shop/dist` and serve `index.html` for unknown paths:

```
VITE_API_URL=https://hq.mysupermarket.co.ke npm run build -w @afeypos/shop
```

The public shop API accepts requests from any website and uses no cookies, so no CORS setting is needed.

## Branch servers

Orders are taken on head office, which is the public server. With branch servers, the order syncs to the branch that fulfils it, and that branch completes it locally. Stock is reserved only where the warehouse is managed (at HQ for HQ warehouses); for a branch warehouse, availability comes from the branch stock HQ last received.

## Security

- The public API exposes only products marked for online sale, their photos, pictures used in the published studio design and the shop settings.
- Shop pages are served with their own Content-Security-Policy: framing only by the POS addresses, scripts only from the shop.
- Order pages need the order's secret link (token) or the customer's phone number.
- Order placement is rate-limited per connection.
- Prices, stock and totals are always recalculated on the server.
- Staff actions need the `orders.manage` permission (cashiers and managers have it) and are audited.

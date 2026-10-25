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
3. Publish the website (below). M-Pesa at checkout uses your Daraja configuration (MPESA.md); SMS updates need the SMS module.

## What customers can do

- Browse by category, search (name, barcode or SKU), and see prices and whether items are in stock.
- Keep a basket (it stays in their browser).
- Check out with delivery (area, address) or pickup.
- Pay by **M-Pesa** (an STK prompt on their phone; if it fails they can send it again from the order page) or **on delivery / at pickup**.
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

Add the name to the reverse proxy (Caddy: `shop.mysupermarket.co.ke { reverse_proxy 127.0.0.1:4000 }`). Requests for that name get the shop; the POS stays on its own address.

**Option B: any static host** (Netlify, Vercel, Cloudflare Pages, an nginx box). Build with the HQ address, then upload `shop/dist` and serve `index.html` for unknown paths:

```
VITE_API_URL=https://hq.mysupermarket.co.ke npm run build -w @afeypos/shop
```

The public shop API accepts requests from any website and uses no cookies, so no CORS setting is needed.

## Branch servers

Orders are taken on head office, which is the public server. With branch servers, the order syncs to the branch that fulfils it, and that branch completes it locally. Stock is reserved only where the warehouse is managed (at HQ for HQ warehouses); for a branch warehouse, availability comes from the branch stock HQ last received.

## Security

- The public API exposes only products marked for online sale, their photos and the shop settings.
- Order pages need the order's secret link (token) or the customer's phone number.
- Order placement is rate-limited per connection.
- Prices, stock and totals are always recalculated on the server.
- Staff actions need the `orders.manage` permission (cashiers and managers have it) and are audited.

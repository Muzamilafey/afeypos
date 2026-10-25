# CRM

*Customers & suppliers → CRM & campaigns* (module **CRM**), and a CRM panel on every customer page.

## Insights

For each customer, over the last 12 months:
- spend, visits, average basket, last visit, customer since, lifetime spend;
- favourite products;
- **tier**, by 12-month spend. The defaults are Bronze, Silver from KES 20,000, Gold from KES 100,000 and Platinum from KES 300,000; change them in the settings (`settings.crm.tiers`);
- **segment**:

| Segment | Rule |
|---|---|
| New | first purchase in the last 30 days |
| Champions | bought within 14 days, 12+ visits in 12 months |
| Loyal | bought within 30 days, 4+ visits |
| Active | bought within 60 days |
| At risk | last purchase 61–120 days ago |
| Lost | over 120 days |

The overview shows segments and tiers, top customers, **valuable customers at risk** (to win back), birthdays this week and follow-ups due.

## Activities and follow-ups

Log calls, visits, notes, complaints, SMS, WhatsApp and email against a customer. Give an activity a follow-up date to make it a task; *Follow-ups* lists everything due. Activities sync between branches and head office.

## Campaigns

1. Write an SMS or email. `{{name}}` becomes the customer's first name.
2. Choose who receives it: segments, tags, birthday month, minimum spend. *Who receives it?* shows the count.
3. Save it as a draft, then send it. Each customer gets it at most once.

Campaigns go **only to customers who agreed to receive offers**:
- record consent on the customer form, and record opt-outs from the CRM panel;
- SMS adds the business name and "Reply STOP to opt out".

This follows the Kenya Data Protection Act, 2019. Receipts and statements are not marketing and don't need consent. Sending needs the SMS or Email module with a provider connected (see NOTIFICATIONS.md).

## Birthday greetings

Turn on `settings.crm.birthdayGreeting` (channel and an optional offer line). At 09:00 every opted-in customer whose birthday it is gets one greeting a year.

## Customer fields

The customer form adds:
- date of birth;
- tags (e.g. `hotel`, `estate a`);
- marketing consent, with the time it was given or withdrawn;
- an account manager.

The customer list can be filtered by tag (`GET /customers?tag=`).

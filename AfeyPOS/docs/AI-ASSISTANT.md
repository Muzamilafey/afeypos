# AI Business Assistant

**Reports → AI Assistant** (`/assistant`) answers questions about the business in plain English or Swahili.

Examples:

- "Which products made the most profit today?"
- "Which branch performed best this month?"
- "Which products should I reorder?"

## How it works

The assistant never queries the database freely. It has a fixed set of **read-only tools** written in
`server/src/modules/assistant/tools.ts`. The AI chooses which tools to call, the server runs them, and the AI
answers from their results.

| Tool | Gives | Needs permission |
|---|---|---|
| `sales_summary` | Sales, revenue before tax, tax, receipts, average basket, discounts, returns, payment methods for a period | `reports.read` |
| `top_products` | Best products by revenue, quantity or gross profit (profit needs `reports.financial`) | `reports.read` |
| `category_revenue` | Revenue per category | `reports.read` |
| `branch_performance` | Revenue, receipts and gross profit per branch | `reports.read` |
| `cashier_performance` | Receipts, sales and voids per cashier | `reports.read` + `sales.read.all` |
| `low_stock` | Products at or below their reorder level | `inventory.read` |
| `dead_stock` | Stock with no sale in N days, and money tied up | `inventory.read` |
| `inventory_value` | Stock value at cost and at retail, per store | `reports.financial` |
| `reorder_suggestions` | Suggested orders per supplier (as Purchase orders → Suggested orders) | `purchasing.read` |
| `sales_trend` | Products whose sales fell or grew most | `reports.read` |
| `unusual_activity` | Voids, drawer opened with no sale, approvals, failed till unlocks | `audit.read` |

The assistant is limited in several ways:

- It only sees the tools the person may use. Tools they lack are never offered to the AI.
- It only sees that person's branches.
- Every tool input is validated. An invalid input goes back to the AI as an error, not to the database.
- Results are summaries only, with no passwords, keys, payment credentials or customer phone numbers.
- It cannot change anything.

## Built-in answers (no AI needed)

Without an AI provider, or when the provider is down or over its daily limit, the assistant still answers the
common questions. It recognises the words and uses the same tools. Ordinary POS work never depends on the AI.

## Setting up a provider

On the assistant page, owners and administrators (`settings.manage`) can:

- choose **Anthropic (Claude)**, **OpenAI** or **Google Gemini**;
- set the model (Claude defaults to `claude-opus-5-5`; OpenAI and Gemini need a model name);
- paste the API key;
- set daily limits per person and per business.

Other details:

- **The API key** is encrypted on the server (AES-256-GCM with `ENCRYPTION_KEY`) and never shown again. Branch
  servers receive the setting by sync.
- **Claude** is called through the official Anthropic SDK (`@anthropic-ai/sdk`) with adaptive thinking at
  `medium` effort. Server-side refusal fallback (`fallbacks: "default"`) is on for models that support it.
- **OpenAI and Gemini** are called through their HTTP APIs with the same tools.
- **Every question is logged** (`AssistantRequest`) with the user, mode, provider, model, tools used, tokens and
  errors. The page shows the 30-day totals.

## Permissions

Asking needs `assistant.use`:

- Owners and administrators have it.
- Branch managers have it by default.
- Add it to custom roles as needed.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/assistant/status` | Mode (AI or built-in), model, suggested questions, today's usage |
| POST | `/assistant/ask` | `{ question, history? }` returns `{ answer, mode, tools }` |
| GET / PUT | `/assistant/config` | Provider, model, key (write only), limits (`settings.manage`) |
| GET | `/assistant/log` | Last 100 questions and 30-day totals (`settings.manage`) |

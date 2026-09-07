# Bank Statement → Odoo Converter

A browser tool that turns the group's bank-statement PDFs into an **Odoo-ready Excel** file
(`Number | Date | Label | Dr | Cr | Balance | Cumulative Amount`).

## How to use

**Option A — just open it (no server):**
Double-click **`Bank Statement to Odoo — standalone.html`**. Drop in your PDFs, pick an export
mode, click **Download Odoo Excel**. (Needs internet on first open — it pulls the pdf.js / SheetJS
libraries from a CDN. Your statement data never leaves the browser.)

**Option B — host it (public URL):**
Serve the folder (or just `index.html` + `parser.js`) from any static host — GitHub Pages,
Netlify, S3, etc. See "Publishing" below.

## Supported banks (auto-detected)

| Bank | Notes |
|---|---|
| **HSBC Business Direct** | HKD Current, HKD Savings, and Foreign-Currency Savings (splits per currency) |
| **Fusion Bank** | Savings + Time-Deposit lines, HKD/USD |
| **PAOB / Ping An** | HKD / USD / CNY savings |
| **Standard Chartered** | one sheet per account & currency |
| **Payoneer** | signed-amount + running-balance layout |
| **Wise** | transfer + fee lines, reverse-chronological |

AmEx card statements are recognised but **not** converted (they're a credit-card bill, not a cash
ledger).

## What it does under the hood

- Reads each PDF **entirely in your browser** with pdf.js — nothing is uploaded anywhere.
- Detects the bank from its letterhead/footer (not from transaction text, so payee names that
  mention other banks don't fool it).
- Rebuilds each transaction by column position, handling multi-line descriptions.
- **Re-computes the running balance for every row and checks it against the bank's printed
  balance.** Any mismatch is flagged in the preview (highlighted row + a warning) so you can
  eyeball it before importing.
- Exports:
  - **One combined workbook** — one sheet per account across all statements, or
  - **One file per statement** (bundled into a `.zip`).

Each sheet opens with a `B/F BALANCE` row, then every transaction. **Dr = money in** (deposits /
credits), **Cr = money out** (withdrawals / debits) — matching the Odoo template.

## Files

- `index.html` — the app (loads `parser.js` beside it). Use this when hosting.
- `parser.js` — the parsing engine (also usable from Node for testing).
- `Bank Statement to Odoo — standalone.html` — everything inlined into one file for double-click use.
- `SAMPLE OUTPUT — combined (Odoo).xlsx` — an example export built from the June statements.

## Publishing (public URL)

The tool holds **no data** — it's pure code — so it's safe to put in a **public** repo.

1. Create a public GitHub repo (e.g. `bank-statement-to-odoo`).
2. Add `index.html` and `parser.js`.
3. Repo → Settings → Pages → deploy from `main` / root.
4. Share the `https://<user>.github.io/bank-statement-to-odoo/` URL.

(Or drag the folder onto Netlify Drop for an instant URL.)

## Adding another bank later

Add a config block in `parser.js` → `BANKS` (a date regex, column x-boundaries, the activity-header
pattern, and how to read the account label), plus a signature in `detectBank()`. The generic engine
handles the rest. Calibrate column x-positions by printing token positions from a sample PDF.

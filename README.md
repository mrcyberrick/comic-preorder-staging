# PULLLIST — Comic Pre-Order System

A web-based pre-order management system for **Ray & Judy's Book Stop**, Rockaway NJ.
Customers browse the monthly comic catalog, reserve titles, and manage their pull list.
The store uses the admin dashboard to track orders and export distributor order sheets.

**Production**: https://mrcyberrick.us/comic-preorder/  
**Staging**: https://mrcyberrick.github.io/comic-preorder-staging/

---

## Features

- Monthly catalog import from Lunar Distribution and PRH (Penguin Random House)
- Customer browse, search, and reserve — with UPC/ISBN search support
- Pull list management with quantity adjustments and CSV export
- Series subscriptions — auto-reserve standard covers each month
- This Week's Arrivals — Wednesday on-sale date view for customers and admin
- Upcoming Arrivals — multi-month forward view on customer pull list
- Admin dashboard — by customer, by distributor, this week, all reservations, subscriptions
- Customer invite via branded email
- Maintenance mode for catalog refresh downtime
- Print/PDF export for customer pull lists and weekly arrivals
- Mobile-responsive with hamburger nav

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript (no build step) |
| Backend | Supabase (PostgreSQL, Auth, RLS, Edge Functions) |
| Hosting | GitHub Pages (static) |
| Email | MailerSend via Supabase Edge Functions |
| Import | Node.js script (runs locally, not in repo) |

---

## Repository Structure

```
/
  catalog.html          ← monthly catalog browse & reserve
  mylist.html           ← customer pull list
  arrivals.html         ← this week's arrivals
  subscriptions.html    ← series subscription management
  admin.html            ← admin dashboard
  app.js                ← shared app logic & Supabase API objects
  style.css             ← all styles
  config.js             ← Supabase credentials (gitignored — never commit)
  CLAUDE.md             ← AI assistant project instructions
  README.md             ← this file
  docs/
    monthly-catalog-refresh.md    ← monthly import SOP
    technical-reference.md        ← architecture & schema reference
```

---

## Setup

### Prerequisites
- Node.js v20+
- A Supabase project with the schema from `docs/technical-reference.md`

### One-Time Database Setup
Run the SQL in `docs/technical-reference.md` → Database Setup section in your
Supabase SQL Editor to create all required tables, functions, and policies.

### config.js
Create `config.js` in the repo root (never commit this file):
```javascript
const SUPABASE_URL      = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

### Import Script
The monthly import script lives outside the repo:
```
C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts\
  import.js         ← production (service role key for prod Supabase)
  import-staging.js ← staging (service role key for staging Supabase)
```

Install dependencies once:
```powershell
cd C:\Users\richa\OneDrive\Documents\(Work)\BookStop\catalogs\scripts
npm install csv-parse
```

---

## Monthly Catalog Refresh

See `docs/monthly-catalog-refresh.md` for the complete step-by-step guide.

Quick summary:
1. Enable Maintenance Mode in admin panel
2. Export order sheets (Lunar + PRH CSVs)
3. Drop new CSV files in the catalogs folder
4. Run `node .\import.js "..\Lunar_Product_Data_MMYY.csv" "..\YYYY_MM_PRH_...csv"`
5. Verify import in Supabase SQL Editor
6. Disable Maintenance Mode

---

## Deployment

### Staging
```powershell
git checkout staging
git push origin staging
git push staging staging:main
```

### Production
Always merge staging → main locally, restoring `config.js` before committing:
```powershell
git checkout main
git pull origin main
git merge staging --no-commit --no-ff
git checkout main -- config.js
git commit -m "feat: description"
git checkout -b feat/description-prod
git push origin feat/description-prod
# Open PR on GitHub — verify config.js not in diff — merge
```

---

## Development Notes

- No build step — edit HTML/CSS/JS files directly
- All pages share `app.js` (loaded via `<script src="app.js">`) and `style.css`
- Supabase credentials loaded from `config.js` which must be present but never committed
- Nav links must be kept in sync across all 5 HTML files — see `CLAUDE.md`
- Never use `toISOString()` for date display — use local date parts to avoid UTC shift
- Supabase `.range()` returns 416 on empty result sets — use count-first approach

---

## Contact

Ray & Judy's Book Stop · Rockaway, NJ · 973-586-9182

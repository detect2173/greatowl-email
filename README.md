# Great Owl Marketing — Email List System

A fully serverless email list system built on:
- **Cloudflare Workers** — API + static site hosting
- **Cloudflare D1** — SQLite subscriber database (free)
- **Resend.com** — transactional email sending (free tier: 3,000/mo)
- **Claude API** — AI-generated welcome emails
- **GitHub Actions** — automated deployment on every push

**Estimated monthly cost: $0** for up to ~3,000 emails/month.

---

## 1. Prerequisites

Make sure you have these installed:
```bash
node --version   # needs v18+
npm --version
```

Then install Wrangler (Cloudflare's CLI):
```bash
npm install -g wrangler
wrangler login   # opens browser to authenticate
```

---

## 2. Create Your D1 Database

```bash
wrangler d1 create greatowl-email-db
```

This will output something like:
```
[[d1_databases]]
binding = "DB"
database_name = "greatowl-email-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy the `database_id`** and paste it into `wrangler.toml` where it says:
```
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

---

## 3. Initialize the Database Schema

Run this to create your tables:
```bash
npm run db:init:remote
```

---

## 4. Set Your Secrets

Never put secrets in `wrangler.toml`. Set them via CLI:

```bash
# Your Resend API key (get from resend.com/api-keys)
wrangler secret put RESEND_API_KEY

# Your Claude API key (get from console.anthropic.com)
wrangler secret put CLAUDE_API_KEY

# A random string — used to sign unsubscribe tokens
# Generate one: openssl rand -hex 32
wrangler secret put UNSUBSCRIBE_SECRET

# A password to protect your /broadcast and /stats endpoints
# Generate one: openssl rand -hex 16
wrangler secret put BROADCAST_KEY
```

---

## 5. Configure Your Domain in wrangler.toml

Update these lines in `wrangler.toml`:
```toml
[vars]
FROM_EMAIL = "hello@greatowlmarketing.com"
FROM_NAME  = "Great Owl Marketing"
SITE_URL   = "https://greatowlmarketing.com"
```

---

## 6. Set Up Resend

1. Go to [resend.com](https://resend.com) and create a free account
2. Add and verify your domain: `greatowlmarketing.com`
   - Resend will give you DNS records to add — add them in your domain registrar
3. Create an API key at resend.com/api-keys
4. Set it: `wrangler secret put RESEND_API_KEY`

---

## 7. Deploy Manually (First Time)

```bash
npm install
wrangler deploy
```

Your Worker will be live at:
`https://greatowl-email.YOUR-ACCOUNT-SUBDOMAIN.workers.dev`

---

## 8. Connect Your Custom Domain

In the Cloudflare dashboard:
1. Go to **Workers & Pages** → your Worker → **Settings** → **Triggers**
2. Click **Add Custom Domain**
3. Enter `greatowlmarketing.com` (or `www.greatowlmarketing.com`)
4. Cloudflare handles SSL automatically

---

## 9. Set Up GitHub Actions (Auto-Deploy)

So every `git push` to `main` auto-deploys:

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Add these repository secrets:

| Secret Name | Where to Get It |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → right sidebar when on Workers page |

3. Push to `main` — GitHub Actions will deploy automatically.

---

## 10. API Reference

### Subscribe
```bash
POST /subscribe
Content-Type: application/json

{
  "email": "user@example.com",
  "first_name": "Jane",    # optional
  "source": "landing_page" # optional tag
}
```

### Check Stats
```bash
GET /stats?key=YOUR_BROADCAST_KEY
```

### Send Broadcast Email
```bash
POST /broadcast
Authorization: Bearer YOUR_BROADCAST_KEY
Content-Type: application/json

{
  "subject": "Big news from Great Owl Marketing",
  "html": "<p>Hello!</p><p>Here's what's new...</p>",
  "text": "Hello! Here's what's new...",
  "tag": "lead"   # optional — only send to subscribers with this tag
}
```

---

## 11. Local Development

```bash
npm run dev
```

This runs the Worker locally at `http://localhost:8787`.
The landing page will be served at that same URL.

For D1 locally, data is stored in a local SQLite file.
Run `npm run db:init` (without `:remote`) to init it locally.

---

## File Structure

```
greatowl-email/
├── src/
│   └── index.js          # Worker — all API routes + email logic
├── public/
│   └── index.html        # Landing page — served as static site
├── .github/
│   └── workflows/
│       └── deploy.yml    # Auto-deploy on push to main
├── schema.sql            # D1 database schema
├── wrangler.toml         # Cloudflare config
├── package.json
└── README.md
```

---

## Upgrading Later

When you outgrow the free tiers:
- **Resend**: $20/mo for 50,000 emails
- **Cloudflare Workers Paid**: $5/mo for 10M requests/month
- **Claude API**: pay-per-use, roughly $0.003 per welcome email

Total at 10,000 subscribers: ~$25/month.

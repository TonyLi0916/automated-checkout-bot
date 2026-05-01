# Automated Checkout Service — Discord Bot

A Discord bot built to automate client onboarding and operations management for an e-commerce checkout service. The bot handles profile collection, data validation, CSV export for third-party checkout tools, and real-time checkout logging to Google Sheets.

Built to manage 30+ active clients across multiple retail platforms.

## Features

### Client Onboarding
- **Ticket system** — Users click a button or run `/ticket` to open a private channel for profile submission
- **Multi-site support** — Pokemon Center, Walmart CA, Costco, GameStop CA, and a Premium Tier
- **Template-based input** — Users paste a structured template; the bot parses and validates all fields
- **Field validation & auto-correction**
  - Card types normalized (`mastercard` → `MasterCard`, `mc` → `MasterCard`)
  - Country codes normalized (`Canada` → `CA`, `United States` → `US`)
  - Province/state abbreviations normalized (`Ontario` → `ON`, `British Columbia` → `BC`)
- **Billing/shipping address separation** — Users can specify different billing and shipping addresses when needed
- **Multi-profile support** — Users can add profiles for multiple sites within a single ticket

### Profile Management
- **JSON storage** — Profiles and accounts stored per-site in structured JSON files
- **Admin commands**
  - `/export <site>` — Generates semicolon-delimited CSV files compatible with third-party checkout tools
  - `/profiles <site>` — Lists all saved profiles with account status
  - `/delete <site> <name>` — Removes a profile and associated account data
- **Separate account handling** — Sites requiring login credentials (Costco) store accounts independently from billing profiles

### Google Sheets Integration
- **Real-time checkout logging** — Monitors a Discord webhook channel for successful checkout notifications
- **Multi-format parsing** — Handles both embed field-based (Walmart, Costco, PKC) and description-based (GameStop) webhook formats
- **Automatic tier detection**
  - Personal checkouts detected by configurable profile name prefix
  - Premium tier matched against stored premium profiles (supports numbered variants)
  - Standard tier as default for all ACO clients
- **Three-tab spreadsheet structure**
  - **Personal** — Owner's checkouts with sold price/profit tracking
  - **Standard** — Client checkouts with 10% fee calculation (including 13% HST)
  - **Premium** — Client checkouts with 110% payout calculation (including 13% HST)
- **Auto-initialization** — Creates tabs and headers on first run

### Setup Channel
- `/setup` — Posts a getting-started embed with an interactive "Open a Ticket" button in any channel (admin only)

## Tech Stack

- **Runtime:** Node.js
- **Discord:** discord.js v14 (slash commands, buttons, select menus, embeds)
- **Google Sheets:** googleapis (Sheets API v4, service account auth)
- **Environment:** dotenv for configuration management
- **Process Management:** PM2 for production deployment

## Project Structure

```
automated-checkout-bot/
├── bot.js              # Main bot — commands, ticket system, webhook listener, Sheets integration
├── package.json        # Dependencies
├── .env.example        # Environment variable template
├── .gitignore          # Excludes secrets, data, and node_modules
├── credentials.json    # Google service account key (not tracked)
└── data/               # Auto-created, stores profiles per site (not tracked)
    ├── walmart_ca_profiles.json
    ├── costco_profiles.json
    ├── costco_accounts.json
    ├── pokemon_center_profiles.json
    ├── gamestop_ca_profiles.json
    ├── premium_tier_profiles.json
    └── ...
```

## Setup

### Prerequisites
- Node.js 18+
- A Discord bot application ([Discord Developer Portal](https://discord.com/developers/applications))
- A Google Cloud service account with Sheets API enabled

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/automated-checkout-bot.git
cd automated-checkout-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application ID |
| `ADMIN_USER_ID` | Your Discord user ID (for admin-only commands) |
| `TICKET_CATEGORY_ID` | Discord category ID where tickets are created |
| `SHEETS_CREDENTIALS` | Path to Google service account JSON key |
| `SPREADSHEET_ID` | Google Sheets spreadsheet ID |
| `WEBHOOK_CHANNEL_ID` | Discord channel ID where checkout webhooks are posted |
| `PERSONAL_PREFIX` | Profile name prefix for personal checkout detection |

### 3. Google Sheets Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Google Sheets API
3. Create a service account and download the JSON key
4. Create a Google Sheet and share it with the service account email (Editor access)

### 4. Discord Bot Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable **Message Content Intent** and **Server Members Intent**
3. Generate an invite URL with `bot` and `applications.commands` scopes and `Administrator` permission
4. Invite the bot to your server

### 5. Run

```bash
# Development
npm start

# Production (with PM2)
npm install -g pm2
pm2 start bot.js --name "aco-bot"
pm2 save
pm2 startup
```

## Commands

| Command | Access | Description |
|---|---|---|
| `/ticket` | Everyone | Opens a private ticket channel for profile submission |
| `/template` | Everyone | Shows all available profile templates |
| `/setup` | Admin | Posts the getting-started embed with ticket button |
| `/export <site>` | Admin | Exports profiles and accounts as CSV |
| `/profiles <site>` | Admin | Lists all profiles for a site |
| `/delete <site> <name>` | Admin | Deletes a profile and associated account |

## Supported Sites

| Site | Account Required | Notes |
|---|---|---|
| Pokemon Center | No | Unique address + email per profile recommended |
| Walmart CA | No | Accountless checkout |
| Costco | Yes | Email + password required |
| GameStop CA | No | Accountless checkout |
| Premium Tier | No | Operator uses client's card + address, client gets paid |

## License

MIT

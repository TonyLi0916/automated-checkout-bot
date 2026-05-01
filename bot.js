const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  AttachmentBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// --- Config ---
const CONFIG = {
  TOKEN: process.env.BOT_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID,
  DATA_DIR: path.join(__dirname, "data"),

  SHEETS_CREDENTIALS: path.join(__dirname, process.env.SHEETS_CREDENTIALS || "credentials.json"),
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  WEBHOOK_CHANNEL_ID: process.env.WEBHOOK_CHANNEL_ID,

  // profiles starting with this prefix are logged as personal
  PERSONAL_PREFIX: process.env.PERSONAL_PREFIX || "Tony Li",
};

// --- Sites ---
const SITES = [
  "walmart_ca",
  "pokemon_center",
  "costco",
  "gamestop_ca",
  "premium_tier",
];
const SITES_REQUIRING_ACCOUNTS = ["costco"];

const SITE_NAMES = {
  walmart_ca: "Walmart CA",
  pokemon_center: "Pokemon Center",
  costco: "Costco",
  gamestop_ca: "GameStop CA",
  premium_tier: "Premium Tier",
};

// --- Storage (JSON files) ---
if (!fs.existsSync(CONFIG.DATA_DIR))
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

function getProfiles(site) {
  const file = path.join(CONFIG.DATA_DIR, `${site}_profiles.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function saveProfile(site, profile) {
  const file = path.join(CONFIG.DATA_DIR, `${site}_profiles.json`);
  const profiles = getProfiles(site);
  const idx = profiles.findIndex(
    (p) => p.PROFILE_NAME === profile.PROFILE_NAME,
  );
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
}

function deleteProfile(site, profileName) {
  const file = path.join(CONFIG.DATA_DIR, `${site}_profiles.json`);
  const profiles = getProfiles(site).filter(
    (p) => p.PROFILE_NAME !== profileName,
  );
  fs.writeFileSync(file, JSON.stringify(profiles, null, 2));
  deleteAccount(site, profileName);
}

function getAccounts(site) {
  const file = path.join(CONFIG.DATA_DIR, `${site}_accounts.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function saveAccount(site, account) {
  const file = path.join(CONFIG.DATA_DIR, `${site}_accounts.json`);
  const accounts = getAccounts(site);
  const idx = accounts.findIndex((a) => a.email === account.email);
  if (idx >= 0) accounts[idx] = account;
  else accounts.push(account);
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2));
}

function deleteAccount(site, profileName) {
  const file = path.join(CONFIG.DATA_DIR, `${site}_accounts.json`);
  const accounts = getAccounts(site).filter(
    (a) => a.profile_name !== profileName,
  );
  fs.writeFileSync(file, JSON.stringify(accounts, null, 2));
}

// --- Google Sheets ---
const { google } = require("googleapis");

let sheetsClient = null;

async function initSheets() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: CONFIG.SHEETS_CREDENTIALS,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: authClient });

    // create tabs if missing
    const spreadsheet = await sheetsClient.spreadsheets.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
    });
    const existingSheets = spreadsheet.data.sheets.map(
      (s) => s.properties.title,
    );
    const requiredTabs = ["Personal", "Standard", "Premium"];

    for (const tab of requiredTabs) {
      if (!existingSheets.includes(tab)) {
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId: CONFIG.SPREADSHEET_ID,
          requestBody: {
            requests: [{ addSheet: { properties: { title: tab } } }],
          },
        });
      }
    }

    // add headers if empty
    for (const tab of requiredTabs) {
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${tab}!A1:M1`,
      });
      if (!res.data.values || res.data.values.length === 0) {
        let headers;
        if (tab === "Personal") {
          headers = [["Date", "Site", "Product", "Qty", "Price", "Total", "Profile", "Order ID", "Sold Price", "Profit", "Status"]];
        } else if (tab === "Premium") {
          headers = [["Date", "Site", "Product", "Qty", "Price", "Total", "Profile", "Order ID", "You Owe (110%)", "Paid", "Sold Price", "Profit", "Status"]];
        } else {
          headers = [["Date", "Site", "Product", "Qty", "Price", "Total", "Profile", "Order ID", "Fee (10%)", "Paid"]];
        }
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: CONFIG.SPREADSHEET_ID,
          range: `${tab}!A1`,
          valueInputOption: "RAW",
          requestBody: { values: headers },
        });
      }
    }

    console.log("✅ Google Sheets connected");
  } catch (err) {
    console.error("❌ Google Sheets init failed:", err.message);
  }
}

function determineTier(profileName) {
  // personal = starts with prefix from .env
  if (profileName.toLowerCase().startsWith(CONFIG.PERSONAL_PREFIX.toLowerCase())) return "Personal";

  // premium = found in premium_tier json
  const premiumProfiles = getProfiles("premium_tier");
  const isPremium = premiumProfiles.some(
    (p) => p.PROFILE_NAME.toLowerCase() === profileName.toLowerCase(),
  );
  if (isPremium) return "Premium";

  // everything else = standard
  return "Standard";
}

async function logCheckoutToSheet(checkoutData) {
  if (!sheetsClient) {
    console.error("Sheets not initialized");
    return;
  }

  const tier = determineTier(checkoutData.profile);
  const total = (checkoutData.price * checkoutData.qty * 1.13).toFixed(2);

  let row;
  let range;
  if (tier === "Personal") {
    row = [
      checkoutData.date,
      checkoutData.site,
      checkoutData.product,
      checkoutData.qty,
      checkoutData.price,
      total,
      checkoutData.profile,
      checkoutData.orderId,
      "",  // sold price
      "",  // profit
      "",  // status
    ];
    range = `${tier}!A:K`;
  } else if (tier === "Premium") {
    const youOwe = (checkoutData.price * checkoutData.qty * 1.13 * 1.1).toFixed(2);
    row = [
      checkoutData.date,
      checkoutData.site,
      checkoutData.product,
      checkoutData.qty,
      checkoutData.price,
      total,
      checkoutData.profile,
      checkoutData.orderId,
      youOwe,
      "❌",
      "",  // sold price
      "",  // profit
      "",  // status
    ];
    range = `${tier}!A:M`;
  } else {
    const fee = (checkoutData.price * checkoutData.qty * 1.13 * 0.1).toFixed(2);
    row = [
      checkoutData.date,
      checkoutData.site,
      checkoutData.product,
      checkoutData.qty,
      checkoutData.price,
      total,
      checkoutData.profile,
      checkoutData.orderId,
      fee,
      "❌",
    ];
    range = `${tier}!A:J`;
  }

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    console.log(`📊 Logged to ${tier}: ${checkoutData.profile} - ${checkoutData.product}`);
  } catch (err) {
    console.error("❌ Failed to log to sheet:", err.message);
  }
}

function parseCheckoutEmbed(embed) {
  if (!embed) return null;

  // check if it's a successful checkout
  const title = embed.title || "";
  const description = embed.description || "";
  const isSuccessful =
    title.toLowerCase().includes("successful checkout") ||
    description.toLowerCase().includes("successful checkout");

  if (!isSuccessful) return null;

  // get date from footer
  let date = new Date().toISOString().split("T")[0];
  if (embed.footer && embed.footer.text) {
    const dateMatch = embed.footer.text.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) date = dateMatch[1];
  }

  // try embed fields first (walmart, costco, pkc)
  if (embed.fields && embed.fields.length > 0) {
    const fields = {};
    for (const field of embed.fields) {
      const cleanValue = field.value.trim().replace(/^\|\||\|\|$/g, "");
      fields[field.name.toLowerCase().trim()] = cleanValue;
    }

    return [{
      site: fields["site"] || "Unknown",
      product: fields["product"] || "Unknown",
      price: parseFloat(fields["price"]) || 0,
      qty: parseInt(fields["qty"]) || 1,
      profile: fields["profile"] || "Unknown",
      orderId: fields["order id"] || "",
      date: date,
    }];
  }

  // fallback: parse description text (gamestop)
  if (description) {
    const lines = description.split("\n").map((l) => l.trim()).filter((l) => l);

    const descFields = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextLine = lines[i + 1] || "";

      const cleanLine = line.replace(/^\|\||\|\|$/g, "").replace(/\*\*/g, "").trim();
      const cleanNext = nextLine.replace(/^\|\||\|\|$/g, "").replace(/\*\*/g, "").trim();

      const key = cleanLine.toLowerCase();

      if (key === "site") descFields["site"] = cleanNext;
      if (key === "profile") descFields["profile"] = cleanNext;
      if (key === "order id") descFields["order id"] = cleanNext;
      if (key === "email") descFields["email"] = cleanNext;
      if (key === "qty") descFields["qty"] = cleanNext;

      const productMatch = key.match(/^product\s*-?\s*(\d+)?$/);
      if (productMatch) {
        const num = productMatch[1] || "1";
        descFields[`product_${num}`] = cleanNext;
      }

      const priceMatch = key.match(/^price\s*-?\s*(\d+)?$/);
      if (priceMatch) {
        const num = priceMatch[1] || "1";
        descFields[`price_${num}`] = cleanNext.replace("$", "");
      }

      const skuMatch = key.match(/^sku\s*-?\s*(\d+)?$/);
      if (skuMatch) {
        // Skip SKU value line
      }
    }

    const profile = descFields["profile"] || "Unknown";
    const site = descFields["site"] || "Unknown";
    const orderId = descFields["order id"] || "";

    const checkouts = [];
    let productNum = 1;
    while (descFields[`product_${productNum}`]) {
      checkouts.push({
        site: site,
        product: descFields[`product_${productNum}`],
        price: parseFloat(descFields[`price_${productNum}`]) || 0,
        qty: parseInt(descFields["qty"]) || 1,
        profile: profile,
        orderId: orderId,
        date: date,
      });
      productNum++;
    }

    if (checkouts.length === 0 && descFields["product_undefined"]) {
    }

    return checkouts.length > 0 ? checkouts : null;
  }

  return null;
}

// --- CSV Export ---
const PROFILE_CSV_HEADER =
  "PROFILE_NAME;EMAIL;PHONE;SHIPPING_FIRST_NAME;SHIPPING_LAST_NAME;SHIPPING_ADDRESS;SHIPPING_ADDRESS_2;SHIPPING_CITY;SHIPPING_ZIP;SHIPPING_STATE;SHIPPING_COUNTRY;BILLING_FIRST_NAME;BILLING_LAST_NAME;BILLING_ADDRESS;BILLING_ADDRESS_2;BILLING_CITY;BILLING_ZIP;BILLING_STATE;BILLING_COUNTRY;BILLING_SAME_AS_SHIPPING;CARD_HOLDER_NAME;CARD_TYPE;CARD_NUMBER;CARD_MONTH;CARD_YEAR;CARD_CVV;ONE_CHECKOUT_PER_PROFILE";

const ACCOUNT_CSV_HEADER = "email;password";

function profileToCSVRow(p) {
  const fields = [
    `"${p.PROFILE_NAME}"`,
    p.EMAIL,
    p.PHONE,
    p.SHIPPING_FIRST_NAME,
    p.SHIPPING_LAST_NAME,
    p.SHIPPING_ADDRESS,
    p.SHIPPING_ADDRESS_2 || "",
    p.SHIPPING_CITY,
    p.SHIPPING_ZIP,
    p.SHIPPING_STATE,
    p.SHIPPING_COUNTRY,
    p.BILLING_FIRST_NAME,
    p.BILLING_LAST_NAME,
    p.BILLING_ADDRESS,
    p.BILLING_ADDRESS_2 || "",
    p.BILLING_CITY,
    p.BILLING_ZIP,
    p.BILLING_STATE,
    p.BILLING_COUNTRY,
    p.BILLING_SAME_AS_SHIPPING,
    p.CARD_HOLDER_NAME,
    p.CARD_TYPE,
    p.CARD_NUMBER,
    p.CARD_MONTH,
    p.CARD_YEAR,
    p.CARD_CVV,
    p.ONE_CHECKOUT_PER_PROFILE,
  ];
  return fields.join(";");
}

function accountToCSVRow(a) {
  return `${a.email};${a.password}`;
}

function generateProfileCSV(site) {
  const profiles = getProfiles(site);
  if (profiles.length === 0) return null;
  const rows = [PROFILE_CSV_HEADER, ...profiles.map(profileToCSVRow)];
  return rows.join("\n");
}

function generateAccountCSV(site) {
  const accounts = getAccounts(site);
  if (accounts.length === 0) return null;
  const rows = [ACCOUNT_CSV_HEADER, ...accounts.map(accountToCSVRow)];
  return rows.join("\n");
}

// --- Template Parser ---
function parseProfileMessage(message) {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l);
  const data = {};

  // order matters — more specific patterns first
  const fieldMap = [
    ["account email", "ACCOUNT_EMAIL"],
    ["account password", "ACCOUNT_PASSWORD"],
    ["profile name", "PROFILE_NAME"],
    ["card holder name", "CARD_HOLDER_NAME"],
    ["card holder", "CARD_HOLDER_NAME"],
    ["cardholder", "CARD_HOLDER_NAME"],
    ["card type", "CARD_TYPE"],
    ["card number", "CARD_NUMBER"],
    ["card month", "CARD_MONTH"],
    ["exp month", "CARD_MONTH"],
    ["card year", "CARD_YEAR"],
    ["exp year", "CARD_YEAR"],
    ["shipping first name", "SHIPPING_FIRST_NAME"],
    ["shipping last name", "SHIPPING_LAST_NAME"],
    ["shipping address 2", "SHIPPING_ADDRESS_2"],
    ["shipping address", "SHIPPING_ADDRESS"],
    ["shipping city", "SHIPPING_CITY"],
    ["shipping zip", "SHIPPING_ZIP"],
    ["shipping postal code", "SHIPPING_ZIP"],
    ["shipping state", "SHIPPING_STATE"],
    ["shipping province", "SHIPPING_STATE"],
    ["shipping country", "SHIPPING_COUNTRY"],
    ["billing first name", "BILLING_FIRST_NAME"],
    ["billing last name", "BILLING_LAST_NAME"],
    ["billing address 2", "BILLING_ADDRESS_2"],
    ["billing address", "BILLING_ADDRESS"],
    ["billing city", "BILLING_CITY"],
    ["billing zip", "BILLING_ZIP"],
    ["billing postal code", "BILLING_ZIP"],
    ["billing state", "BILLING_STATE"],
    ["billing province", "BILLING_STATE"],
    ["billing country", "BILLING_COUNTRY"],
    ["email", "EMAIL"],
    ["phone", "PHONE"],
    ["first name", "SHIPPING_FIRST_NAME"],
    ["last name", "SHIPPING_LAST_NAME"],
    ["address 2", "SHIPPING_ADDRESS_2"],
    ["address", "SHIPPING_ADDRESS"],
    ["city", "SHIPPING_CITY"],
    ["zip", "SHIPPING_ZIP"],
    ["postal code", "SHIPPING_ZIP"],
    ["state", "SHIPPING_STATE"],
    ["province", "SHIPPING_STATE"],
    ["country", "SHIPPING_COUNTRY"],
    ["cvv", "CARD_CVV"],
    ["one checkout per profile", "ONE_CHECKOUT_PER_PROFILE"],
  ];

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    for (const [pattern, field] of fieldMap) {
      if (key.includes(pattern)) {
        data[field] = value;
        break;
      }
    }
  }

  // auto-correct card type
  const CARD_TYPE_MAP = {
    visa: "Visa",
    mastercard: "MasterCard",
    "master card": "MasterCard",
    mc: "MasterCard",
    amex: "Amex",
    "american express": "Amex",
    discover: "Discover",
    jcb: "JCB",
  };
  if (data.CARD_TYPE) {
    const normalized = CARD_TYPE_MAP[data.CARD_TYPE.toLowerCase().trim()];
    if (normalized) data.CARD_TYPE = normalized;
  }

  // auto-correct country
  const COUNTRY_MAP = {
    canada: "CA",
    can: "CA",
    ca: "CA",
    "united states": "US",
    "united states of america": "US",
    usa: "US",
    us: "US",
  };
  if (data.SHIPPING_COUNTRY) {
    const normalized = COUNTRY_MAP[data.SHIPPING_COUNTRY.toLowerCase().trim()];
    if (normalized) data.SHIPPING_COUNTRY = normalized;
  }
  if (data.BILLING_COUNTRY) {
    const normalized = COUNTRY_MAP[data.BILLING_COUNTRY.toLowerCase().trim()];
    if (normalized) data.BILLING_COUNTRY = normalized;
  }

  // auto-correct province
  const PROVINCE_MAP = {
    ontario: "ON",
    quebec: "QC",
    "british columbia": "BC",
    alberta: "AB",
    manitoba: "MB",
    saskatchewan: "SK",
    "nova scotia": "NS",
    "new brunswick": "NB",
    newfoundland: "NL",
    "newfoundland and labrador": "NL",
    "prince edward island": "PE",
    pei: "PE",
    "northwest territories": "NT",
    nunavut: "NU",
    yukon: "YT",
  };
  if (data.SHIPPING_STATE) {
    const normalized = PROVINCE_MAP[data.SHIPPING_STATE.toLowerCase().trim()];
    if (normalized) data.SHIPPING_STATE = normalized;
  }
  if (data.BILLING_STATE) {
    const normalized = PROVINCE_MAP[data.BILLING_STATE.toLowerCase().trim()];
    if (normalized) data.BILLING_STATE = normalized;
  }

  // if billing was provided separately, keep it
  const hasBillingFields =
    data.BILLING_FIRST_NAME || data.BILLING_ADDRESS || data.BILLING_CITY;

  if (!hasBillingFields) {
    // same address
    data.BILLING_FIRST_NAME = data.SHIPPING_FIRST_NAME || "";
    data.BILLING_LAST_NAME = data.SHIPPING_LAST_NAME || "";
    data.BILLING_ADDRESS = data.SHIPPING_ADDRESS || "";
    data.BILLING_ADDRESS_2 = data.SHIPPING_ADDRESS_2 || "";
    data.BILLING_CITY = data.SHIPPING_CITY || "";
    data.BILLING_ZIP = data.SHIPPING_ZIP || "";
    data.BILLING_STATE = data.SHIPPING_STATE || "";
    data.BILLING_COUNTRY = data.SHIPPING_COUNTRY || "";
    data.BILLING_SAME_AS_SHIPPING = "TRUE";
  } else {
    // different addresses
    if (!data.BILLING_LAST_NAME) data.BILLING_LAST_NAME = "";
    if (!data.BILLING_ADDRESS_2) data.BILLING_ADDRESS_2 = "";
    if (!data.BILLING_ZIP) data.BILLING_ZIP = data.SHIPPING_ZIP || "";
    if (!data.BILLING_STATE) data.BILLING_STATE = data.SHIPPING_STATE || "";
    if (!data.BILLING_COUNTRY)
      data.BILLING_COUNTRY = data.SHIPPING_COUNTRY || "";
    data.BILLING_SAME_AS_SHIPPING = "FALSE";
  }
  if (!data.ONE_CHECKOUT_PER_PROFILE) data.ONE_CHECKOUT_PER_PROFILE = "FALSE";

  return data;
}

function validateProfile(data, sites) {
  const required = [
    "PROFILE_NAME",
    "EMAIL",
    "PHONE",
    "SHIPPING_FIRST_NAME",
    "SHIPPING_LAST_NAME",
    "SHIPPING_ADDRESS",
    "SHIPPING_CITY",
    "SHIPPING_ZIP",
    "SHIPPING_STATE",
    "SHIPPING_COUNTRY",
    "CARD_HOLDER_NAME",
    "CARD_TYPE",
    "CARD_NUMBER",
    "CARD_MONTH",
    "CARD_YEAR",
    "CARD_CVV",
  ];

  // require account fields for certain sites
  const needsAccount = sites.some((s) => SITES_REQUIRING_ACCOUNTS.includes(s));
  if (needsAccount) {
    required.push("ACCOUNT_EMAIL", "ACCOUNT_PASSWORD");
  }

  const missing = required.filter((f) => !data[f]);
  return missing;
}

// ============================================================
// IN-MEMORY STATE — avoids Discord channel-edit rate limits
// ============================================================
const channelState = new Map(); // channelId → { sites: [...], jig: "jig"|"no_jig" }

// --- Bot Setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Slash Commands ---
async function registerCommands() {
  const siteChoices = [
    { name: "Walmart CA", value: "walmart_ca" },
    { name: "Pokemon Center", value: "pokemon_center" },
    { name: "Costco", value: "costco" },
    { name: "GameStop CA", value: "gamestop_ca" },
    { name: "Premium Tier", value: "premium_tier" },
  ];

  const commands = [
    new SlashCommandBuilder()
      .setName("ticket")
      .setDescription("Open an ACO profile ticket"),
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription(
        "Post the ACO getting started message with ticket button (admin only)",
      ),
    new SlashCommandBuilder()
      .setName("export")
      .setDescription("Export profiles & accounts as Stellar CSV (admin only)")
      .addStringOption((opt) =>
        opt
          .setName("site")
          .setDescription("Site to export")
          .setRequired(true)
          .addChoices(...siteChoices),
      ),
    new SlashCommandBuilder()
      .setName("profiles")
      .setDescription("List all profiles for a site (admin only)")
      .addStringOption((opt) =>
        opt
          .setName("site")
          .setDescription("Site to list")
          .setRequired(true)
          .addChoices(...siteChoices),
      ),
    new SlashCommandBuilder()
      .setName("delete")
      .setDescription("Delete a profile (admin only)")
      .addStringOption((opt) =>
        opt
          .setName("site")
          .setDescription("Site")
          .setRequired(true)
          .addChoices(...siteChoices),
      )
      .addStringOption((opt) =>
        opt
          .setName("profile_name")
          .setDescription("Profile name to delete")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("template")
      .setDescription("Show the profile template to copy/paste"),
  ];

  const rest = new REST({ version: "10" }).setToken(CONFIG.TOKEN);
  await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log("✅ Slash commands registered");
}

// --- Templates ---
const PROFILE_TEMPLATE_BASE = `\`\`\`
Profile Name: 
Email: 
Phone: 
First Name: 
Last Name: 
Address: 
Address 2: 
City: 
Zip/Postal Code: 
State/Province: 
Country: 
Card Holder Name: 
Card Type: 
Card Number: 
Exp Month: 
Exp Year: 
CVV: 
\`\`\``;

const ACCOUNT_TEMPLATE = `\`\`\`
Account Email: 
Account Password: 
\`\`\``;

const PROFILE_TEMPLATE_WITH_ACCOUNT = `\`\`\`
Profile Name: 
Email: 
Phone: 
First Name: 
Last Name: 
Address: 
Address 2: 
City: 
Zip/Postal Code: 
State/Province: 
Country: 
Card Holder Name: 
Card Type: 
Card Number: 
Exp Month: 
Exp Year: 
CVV: 
Account Email: 
Account Password: 
\`\`\``;

const PROFILE_TEMPLATE_PKC_JIG = `\`\`\`
Profile Name: 
Email: 
Phone: 
Shipping First Name: 
Shipping Last Name: 
Shipping Address: 
Shipping Address 2: 
Shipping City: 
Shipping Zip/Postal Code: 
Shipping State/Province: 
Shipping Country: 
Billing First Name: 
Billing Last Name: 
Billing Address: 
Billing Address 2: 
Billing City: 
Billing Zip/Postal Code: 
Billing State/Province: 
Billing Country: 
Card Holder Name: 
Card Type: 
Card Number: 
Exp Month: 
Exp Year: 
CVV: 
\`\`\``;

// --- Event Handlers ---
client.once("ready", async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  await registerCommands();
  await initSheets();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "template") {
    const embed = new EmbedBuilder()
      .setTitle("📋 ACO Profile Templates")
      .setDescription(
        "**For Pokemon Center / Premium Tier (no account needed):**\n" +
          PROFILE_TEMPLATE_BASE +
          "\n\n" +
          "**For Walmart CA / Costco (account required):**\n" +
          PROFILE_TEMPLATE_WITH_ACCOUNT +
          "\n\n" +
          "**If shipping ≠ billing address (PKC / Premium):**\n" +
          PROFILE_TEMPLATE_PKC_JIG,
      )
      .setColor(0x5865f2)
      .setFooter({ text: "Paste your filled template in the ticket channel" });

    await interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "setup") {
    if (interaction.user.id !== CONFIG.ADMIN_USER_ID) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle("🎟️ ACO — Getting Started")
      .setDescription(
        "Welcome to Tony's ACO service!\n\n" +
          "**How it works:**\n" +
          "Click the button below to open a private ticket. You'll select your site(s) and submit your profile info. I'll handle the rest.\n\n" +
          "**Available sites:**\n" +
          "⚡ **Pokemon Center** — no account needed\n" +
          "🛒 **Walmart CA** — no account needed\n" +
          "📦 **Costco** — account required\n" +
          "🎮 **GameStop CA** — no account needed\n" +
          "💎 **Premium Tier** — I use your card + address, you get paid\n\n" +
          "⚠️ Your info is auto-deleted after saving for security.",
      )
      .setColor(0x57f287);

    const ticketButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_ticket")
        .setLabel("Open a Ticket")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🎟️"),
    );

    await interaction.channel.send({
      embeds: [embed],
      components: [ticketButton],
    });
    await interaction.reply({
      content: "✅ Setup message posted.",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "ticket") {
    const guild = interaction.guild;
    const user = interaction.user;

    const ticketChannel = await guild.channels.create({
      name: `aco-${user.username}`,
      type: ChannelType.GuildText,
      parent: CONFIG.TICKET_CATEGORY_ID || undefined,
      permissionOverwrites: [
        { id: guild.id, deny: ["ViewChannel"] },
        {
          id: user.id,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
        {
          id: CONFIG.ADMIN_USER_ID,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
      ],
    });

    const siteSelect = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("site_select")
        .setPlaceholder("Select a site for ACO")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          {
            label: "Pokemon Center",
            value: "pokemon_center",
            emoji: "⚡",
            description: "No account needed",
          },
          {
            label: "Walmart CA",
            value: "walmart_ca",
            emoji: "🛒",
            description: "No account needed",
          },
          {
            label: "Costco",
            value: "costco",
            emoji: "📦",
            description: "Account required",
          },
          {
            label: "GameStop CA",
            value: "gamestop_ca",
            emoji: "🎮",
            description: "No account needed",
          },
          {
            label: "Premium Tier",
            value: "premium_tier",
            emoji: "💎",
            description: "I use your card + address, you get paid",
          },
        ),
    );

    const embed = new EmbedBuilder()
      .setTitle("🎟️ ACO Profile Submission")
      .setDescription(
        `Welcome ${user}!\n\n` +
          "**Step 1:** Select the site(s) you want ACO for below.\n" +
          "**Step 2:** The bot will show you the right template based on your selection.\n\n" +
          "⚠️ **Card Type** should be: `Visa`, `Mastercard`, or `Amex`\n" +
          "⚠️ **Country** should be: `CA` or `US`\n" +
          "⚠️ **Exp Month** format: `01` - `12`\n" +
          "⚠️ **Exp Year** format: `26`, `27`, etc.\n\n" +
          "🔒 Your message will be auto-deleted after saving for security.",
      )
      .setColor(0x57f287);

    await ticketChannel.send({ embeds: [embed], components: [siteSelect] });
    await interaction.reply({
      content: `✅ Ticket created: ${ticketChannel}`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "export") {
    if (interaction.user.id !== CONFIG.ADMIN_USER_ID) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const site = interaction.options.getString("site");
    const profileCSV = generateProfileCSV(site);
    const accountCSV = generateAccountCSV(site);

    if (!profileCSV && !accountCSV) {
      return interaction.reply({
        content: `No data found for **${SITE_NAMES[site]}**.`,
        ephemeral: true,
      });
    }

    const files = [];
    const descriptions = [];

    if (profileCSV) {
      const profileFileName = `stellar_profiles_${site}_${Date.now()}.csv`;
      const profileFilePath = path.join(CONFIG.DATA_DIR, profileFileName);
      fs.writeFileSync(profileFilePath, profileCSV);
      files.push(
        new AttachmentBuilder(profileFilePath, { name: profileFileName }),
      );
      descriptions.push(`**Profiles:** ${getProfiles(site).length}`);
      setTimeout(() => {
        try {
          fs.unlinkSync(profileFilePath);
        } catch (e) {}
      }, 5000);
    }

    if (accountCSV && SITES_REQUIRING_ACCOUNTS.includes(site)) {
      const accountFileName = `stellar_accounts_${site}_${Date.now()}.csv`;
      const accountFilePath = path.join(CONFIG.DATA_DIR, accountFileName);
      fs.writeFileSync(accountFilePath, accountCSV);
      files.push(
        new AttachmentBuilder(accountFilePath, { name: accountFileName }),
      );
      descriptions.push(`**Accounts:** ${getAccounts(site).length}`);
      setTimeout(() => {
        try {
          fs.unlinkSync(accountFilePath);
        } catch (e) {}
      }, 5000);
    }

    const embed = new EmbedBuilder()
      .setTitle(`📤 Export: ${SITE_NAMES[site]}`)
      .setDescription(descriptions.join("\n"))
      .setColor(0x5865f2)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], files, ephemeral: true });
  }

  if (interaction.commandName === "profiles") {
    if (interaction.user.id !== CONFIG.ADMIN_USER_ID) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const site = interaction.options.getString("site");
    const profiles = getProfiles(site);
    const accounts = getAccounts(site);

    if (profiles.length === 0) {
      return interaction.reply({
        content: `No profiles for **${SITE_NAMES[site]}**.`,
        ephemeral: true,
      });
    }

    const list = profiles
      .map((p, i) => {
        const hasAccount = accounts.some(
          (a) => a.profile_name === p.PROFILE_NAME,
        );
        const accountIcon = SITES_REQUIRING_ACCOUNTS.includes(site)
          ? hasAccount
            ? " ✅"
            : " ⚠️ no account"
          : "";
        return `${i + 1}. **${p.PROFILE_NAME}** — ${p.EMAIL}${accountIcon}`;
      })
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`📋 Profiles: ${SITE_NAMES[site]}`)
      .setDescription(list)
      .setColor(0x5865f2)
      .setFooter({ text: `${profiles.length} profile(s)` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "delete") {
    if (interaction.user.id !== CONFIG.ADMIN_USER_ID) {
      return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    const site = interaction.options.getString("site");
    const profileName = interaction.options.getString("profile_name");
    deleteProfile(site, profileName);

    await interaction.reply({
      content: `🗑️ Deleted profile & account for **${profileName}** from **${SITE_NAMES[site]}**.`,
      ephemeral: true,
    });
  }
});

// --- Site Selection ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  if (
    interaction.customId === "site_select" ||
    interaction.customId === "site_select_new"
  ) {
    const selectedSites = interaction.values;
    const siteLabels = selectedSites.map((s) => SITE_NAMES[s]).join(", ");
    const needsAccount = selectedSites.some((s) =>
      SITES_REQUIRING_ACCOUNTS.includes(s),
    );
    const hasPKC = selectedSites.includes("pokemon_center");
    const hasPremium = selectedSites.includes("premium_tier");

    // Store the selection in memory (not channel topic — avoids rate limits)
    channelState.set(interaction.channel.id, {
      sites: selectedSites,
      jig: null,
    });

    // Ask about shipping vs billing address
    if (true) {
      const addressSelect = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("address_select")
          .setPlaceholder(
            "Is your shipping address the same as your billing address?",
          )
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            {
              label: "Yes — same shipping and billing address",
              value: "same_address",
              emoji: "📦",
            },
            {
              label: "No — different shipping and billing address",
              value: "diff_address",
              emoji: "🔀",
            },
          ),
      );

      await interaction.update({
        content: `✅ Selected: **${siteLabels}**\n\n📬 **Is your shipping address the same as your billing address?**`,
        components: [addressSelect],
      });
      return;
    }

    // No PKC or Premium — show normal template
    const template = needsAccount
      ? PROFILE_TEMPLATE_WITH_ACCOUNT
      : PROFILE_TEMPLATE_BASE;
    const accountNote = needsAccount
      ? "\n\n🔑 **Account info is required** for Walmart CA / Costco. Make sure to include your account email and password."
      : "";

    await interaction.update({
      content: `✅ Selected: **${siteLabels}**${accountNote}\n\nCopy, fill out, and paste this template:\n${template}`,
      components: [],
    });
  }

  if (interaction.customId === "address_select") {
    const addressChoice = interaction.values[0];
    const state = channelState.get(interaction.channel.id) || {
      sites: [],
      jig: null,
    };
    const sites = state.sites;
    const siteLabels = sites.map((s) => SITE_NAMES[s]).join(", ");
    const needsAccount = sites.some((s) =>
      SITES_REQUIRING_ACCOUNTS.includes(s),
    );

    // Store address choice in memory
    const jigValue = addressChoice === "diff_address" ? "jig" : "no_jig";
    state.jig = jigValue;
    channelState.set(interaction.channel.id, state);

    let template;
    if (addressChoice === "diff_address") {
      if (needsAccount) {
        template = PROFILE_TEMPLATE_PKC_JIG;
        await interaction.update({
          content: `✅ Selected: **${siteLabels}** (separate addresses)\n\n🔑 **Account info is also required** for Walmart CA / Costco.\n⚠️ Submit your profile with separate addresses first using the template below, then submit a **separate profile with account info** for Walmart/Costco.\n\n📬 **Billing address** = the address on file with your credit card\n📦 **Shipping address** = where you want the package sent\n\n${template}`,
          components: [],
        });
      } else {
        template = PROFILE_TEMPLATE_PKC_JIG;
        await interaction.update({
          content: `✅ Selected: **${siteLabels}** (separate addresses)\n\n📬 **Billing address** = the address on file with your credit card\n📦 **Shipping address** = where you want the package sent\n\nCopy, fill out, and paste this template:\n${template}`,
          components: [],
        });
      }
    } else {
      // Same address — normal flow
      template = needsAccount
        ? PROFILE_TEMPLATE_WITH_ACCOUNT
        : PROFILE_TEMPLATE_BASE;
      const accountNote = needsAccount
        ? "\n\n🔑 **Account info is required** for Walmart CA / Costco. Make sure to include your account email and password."
        : "";

      await interaction.update({
        content: `✅ Selected: **${siteLabels}**${accountNote}\n\nCopy, fill out, and paste this template:\n${template}`,
        components: [],
      });
    }
  }
});

// --- Profile Submission Handler ---
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.name?.startsWith("aco-")) return;

  const content = message.content;
  if (
    !content.toLowerCase().includes("profile name") &&
    !content.toLowerCase().includes("email")
  )
    return;

  // Get selected sites and jig setting from in-memory state
  const state = channelState.get(message.channel.id) || {
    sites: [],
    jig: null,
  };
  const sites = state.sites;
  const isJig = state.jig === "jig";

  if (sites.length === 0) {
    return message.reply(
      "⚠️ Please select your site(s) first using the dropdown menu above.",
    );
  }

  const profile = parseProfileMessage(content);
  const missing = validateProfile(profile, sites);

  if (missing.length > 0) {
    const friendlyNames = {
      PROFILE_NAME: "Profile Name",
      EMAIL: "Email",
      PHONE: "Phone",
      SHIPPING_FIRST_NAME: "First Name",
      SHIPPING_LAST_NAME: "Last Name",
      SHIPPING_ADDRESS: "Address",
      SHIPPING_CITY: "City",
      SHIPPING_ZIP: "Zip/Postal Code",
      SHIPPING_STATE: "State/Province",
      SHIPPING_COUNTRY: "Country",
      CARD_HOLDER_NAME: "Card Holder Name",
      CARD_TYPE: "Card Type",
      CARD_NUMBER: "Card Number",
      CARD_MONTH: "Exp Month",
      CARD_YEAR: "Exp Year",
      CARD_CVV: "CVV",
      ACCOUNT_EMAIL: "Account Email",
      ACCOUNT_PASSWORD: "Account Password",
    };
    const missingLabels = missing
      .map((f) => `\`${friendlyNames[f] || f}\``)
      .join(", ");
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Missing Fields")
      .setDescription(`Please include the following fields:\n${missingLabels}`)
      .setColor(0xed4245);
    return message.reply({ embeds: [embed] });
  }

  // Save profile to each selected site
  for (const site of sites) {
    saveProfile(site, profile);

    // Save account info if site requires it
    if (SITES_REQUIRING_ACCOUNTS.includes(site) && profile.ACCOUNT_EMAIL) {
      saveAccount(site, {
        profile_name: profile.PROFILE_NAME,
        email: profile.ACCOUNT_EMAIL,
        password: profile.ACCOUNT_PASSWORD,
      });
    }
  }

  const siteLabels = sites.map((s) => SITE_NAMES[s]).join(", ");
  const needsAccount = sites.some((s) => SITES_REQUIRING_ACCOUNTS.includes(s));

  const embed = new EmbedBuilder()
    .setTitle("✅ Profile Saved")
    .setDescription(
      `**${profile.PROFILE_NAME}** has been saved for: **${siteLabels}**\n` +
        (needsAccount ? `Account: **${profile.ACCOUNT_EMAIL}**\n` : "") +
        "\nYour profile will be imported before the next drop. You can update it by pasting a new template.",
    )
    .setColor(0x57f287)
    .setTimestamp();

  const addAnotherRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("add_another_different")
      .setLabel("Add profile for a different site")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("➕"),
  );

  // delete original msg for security
  try {
    await message.delete();
  } catch (e) {
    // May not have perms
  }

  await message.channel.send({ embeds: [embed], components: [addAnotherRow] });
});

// --- Add Another Profile ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "add_another_different") {
    // Show the site select dropdown again
    const siteSelect = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("site_select_new")
        .setPlaceholder("Select a site for this profile")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          {
            label: "Pokemon Center",
            value: "pokemon_center",
            emoji: "⚡",
            description: "No account needed",
          },
          {
            label: "Walmart CA",
            value: "walmart_ca",
            emoji: "🛒",
            description: "No account needed",
          },
          {
            label: "Costco",
            value: "costco",
            emoji: "📦",
            description: "Account required",
          },
          {
            label: "GameStop CA",
            value: "gamestop_ca",
            emoji: "🎮",
            description: "No account needed",
          },
          {
            label: "Premium Tier",
            value: "premium_tier",
            emoji: "💎",
            description: "I use your card + address, you get paid",
          },
        ),
    );

    await interaction.reply({
      content: "➕ **Adding a profile for a different site.** Select below:",
      components: [siteSelect],
    });
  }

  if (interaction.customId === "open_ticket") {
    const guild = interaction.guild;
    const user = interaction.user;

    const ticketChannel = await guild.channels.create({
      name: `aco-${user.username}`,
      type: ChannelType.GuildText,
      parent: CONFIG.TICKET_CATEGORY_ID || undefined,
      permissionOverwrites: [
        { id: guild.id, deny: ["ViewChannel"] },
        {
          id: user.id,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
        {
          id: CONFIG.ADMIN_USER_ID,
          allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
        },
      ],
    });

    const siteSelect = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("site_select")
        .setPlaceholder("Select a site for ACO")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          {
            label: "Pokemon Center",
            value: "pokemon_center",
            emoji: "⚡",
            description: "No account needed",
          },
          {
            label: "Walmart CA",
            value: "walmart_ca",
            emoji: "🛒",
            description: "No account needed",
          },
          {
            label: "Costco",
            value: "costco",
            emoji: "📦",
            description: "Account required",
          },
          {
            label: "GameStop CA",
            value: "gamestop_ca",
            emoji: "🎮",
            description: "No account needed",
          },
          {
            label: "Premium Tier",
            value: "premium_tier",
            emoji: "💎",
            description: "I use your card + address, you get paid",
          },
        ),
    );

    const embed = new EmbedBuilder()
      .setTitle("🎟️ ACO Profile Submission")
      .setDescription(
        `Welcome ${user}!\n\n` +
          "**Step 1:** Select the site(s) you want ACO for below.\n" +
          "**Step 2:** The bot will show you the right template based on your selection.\n\n" +
          "⚠️ **Card Type** should be: `Visa`, `Mastercard`, or `Amex`\n" +
          "⚠️ **Country** should be: `CA` or `US`\n" +
          "⚠️ **Exp Month** format: `01` - `12`\n" +
          "⚠️ **Exp Year** format: `26`, `27`, etc.\n\n" +
          "🔒 Your message will be auto-deleted after saving for security.",
      )
      .setColor(0x57f287);

    await ticketChannel.send({ embeds: [embed], components: [siteSelect] });
    await interaction.reply({
      content: `✅ Ticket created: ${ticketChannel}`,
      ephemeral: true,
    });
  }
});

// --- Webhook Listener ---
client.on("messageCreate", async (message) => {
  if (message.channel.id !== CONFIG.WEBHOOK_CHANNEL_ID) return;

  if (message.embeds && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      const checkouts = parseCheckoutEmbed(embed);
      if (checkouts && checkouts.length > 0) {
        for (const checkoutData of checkouts) {
          await logCheckoutToSheet(checkoutData);
        }
      }
    }
  }
});

// --- Start ---
client.login(CONFIG.TOKEN);

/**
 * Connect a company to its own Zoho Books organisation.
 *
 * Zoho credentials used to be environment variables, which meant one
 * organisation for the whole deployment. Each company now holds its own: the
 * organisation id in zoho_connections, the refresh token in Vault.
 *
 * Run once per client. With no arguments it moves THIS deployment's existing
 * .env credentials to the one company that already exists, which is the
 * migration step — nothing changes about which books you are looking at, only
 * where the credentials are kept.
 *
 *   node scripts/zoho-connect.mjs
 *   node scripts/zoho-connect.mjs --company <uuid> --org <zoho org id> \
 *        --refresh-token <token> [--region ae|com|eu|in|au]
 *
 * The token is passed to the database and never written to a file or logged.
 */
import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

const REGIONS = {
  com: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com/books/v3" },
  ae: { accounts: "https://accounts.zoho.ae", api: "https://www.zohoapis.ae/books/v3" },
  eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu/books/v3" },
  in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in/books/v3" },
  au: { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au/books/v3" },
};

function env() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* no .env is fine when every value is passed as an argument */
  }
  return out;
}

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const E = env();
const URL_ = E.SUPABASE_URL;
const SERVICE = E.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env");
  exit(1);
}

const rest = (path, init = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

/** Derive the region from whatever the .env already points at. */
function regionFromEnv() {
  const api = E.ZOHO_API_BASE_URL ?? "";
  for (const [key, urls] of Object.entries(REGIONS)) {
    if (api.startsWith(urls.api.replace("/books/v3", ""))) return key;
  }
  return "com";
}

const main = async () => {
  let companyId = arg("company");
  if (!companyId) {
    const rows = await rest("/rest/v1/company_config?select=company_id").then((r) => r.json());
    if (!Array.isArray(rows) || rows.length !== 1) {
      console.error(
        `Found ${Array.isArray(rows) ? rows.length : 0} companies. Name the one to connect with --company <uuid>.`,
      );
      exit(1);
    }
    companyId = rows[0].company_id;
    console.log(`Company: ${companyId} (the only one)`);
  }

  const organizationId = arg("org") ?? E.ZOHO_ORGANIZATION_ID;
  const refreshToken = arg("refresh-token") ?? E.ZOHO_REFRESH_TOKEN;
  const region = arg("region") ?? regionFromEnv();
  const urls = REGIONS[region];

  if (!organizationId || !refreshToken) {
    console.error(
      "Need a Zoho organisation id and refresh token — pass --org and --refresh-token, " +
        "or leave ZOHO_ORGANIZATION_ID and ZOHO_REFRESH_TOKEN in .env to migrate this deployment's own.",
    );
    exit(1);
  }
  if (!urls) {
    console.error(`Unknown region "${region}". One of: ${Object.keys(REGIONS).join(", ")}`);
    exit(1);
  }

  const res = await rest("/rest/v1/rpc/zoho_connect", {
    method: "POST",
    body: JSON.stringify({
      p_company_id: companyId,
      p_organization_id: organizationId,
      p_refresh_token: refreshToken,
      p_accounts_url: urls.accounts,
      p_api_base_url: urls.api,
    }),
  });

  if (!res.ok) {
    console.error(`Could not connect: ${res.status} ${await res.text()}`);
    exit(1);
  }

  console.log(`Connected company ${companyId} to Zoho organisation ${organizationId} (${region}).`);
  console.log("The refresh token is in Vault; only the service role can read it.");
  console.log(
    "\nWhen every company is connected, remove ZOHO_ORGANIZATION_ID and " +
      "ZOHO_REFRESH_TOKEN from .env — nothing reads them any more, and a stale " +
      "copy of a live credential in a file is exactly what this moved away from.",
  );
};

await main();

// Saves a wallet's key so the mainnet deploy script can sign. Run it yourself, in your own terminal:
//
//   npx tsx bin/import-key.ts <account.near>
//
// Paste the account's 12-word recovery phrase or its private key (ed25519:...) when asked. Nothing you type is shown,
// printed or sent anywhere: the script checks the derived public key against the account's keys on mainnet (a public
// read), then writes ~/.near-credentials/mainnet/<account>.json readable only by you. Delete that file after deploying.
import { parseKey, parseSeedPhrase } from "near-kit";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAINNET } from "../src/config.ts";

const account = process.argv[2];
if (!account) throw new Error("usage: import-key.ts <account.near>");

/** Read one line from the terminal without echoing it. */
function hidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding("utf8");
    let s = "";
    const on = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", on); process.stdout.write("\n"); return resolve(s.trim()); }
        if (c === "\u0003") process.exit(130); // Ctrl-C
        if (c === "\u007f") s = s.slice(0, -1); else s += c;
      }
    };
    stdin.on("data", on);
  });
}

const input = await hidden("Recovery phrase or private key (hidden): ");
const kp = input.startsWith("ed25519:") ? parseKey(input as `ed25519:${string}`) : parseSeedPhrase(input.replace(/\s+/g, " "));
const pub = String(kp.publicKey);
const r = await fetch(MAINNET.rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: account } }) });
const keys: { public_key: string; access_key: { permission: unknown } }[] = (await r.json())?.result?.keys ?? [];
const match = keys.find((k) => k.public_key === pub);
if (!match) {
  console.error(`That key is not on ${account} (it has ${keys.length} keys). Nothing was saved. Check the account name, or export the key again.`);
  process.exit(1);
}
if (match.access_key.permission !== "FullAccess") { console.error("That is a limited key; deploying needs a full-access key. Nothing was saved."); process.exit(1); }
const dir = join(homedir(), ".near-credentials", "mainnet");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${account}.json`);
writeFileSync(file, JSON.stringify({ account_id: account, public_key: pub, private_key: kp.secretKey }), { mode: 0o600 });
console.log(`Saved a full-access key for ${account} (${pub.slice(0, 16)}…) to ${file}. Delete it after deploying.`);

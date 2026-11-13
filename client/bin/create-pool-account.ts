// Creates the pool's own account as a sub-account of yours, with a fresh key made on this machine.
//
//   npx tsx bin/create-pool-account.ts <parent.near> <name> <near>          # dry run: checks only
//   npx tsx bin/create-pool-account.ts <parent.near> <name> <near> --send   # creates <name>.<parent.near>
//
// Signs with <parent.near>'s key from ~/.near-credentials/mainnet/ (save it with bin/import-key.ts). The new account's
// key is generated here, never printed, and saved to ~/.near-credentials/mainnet/<name>.<parent>.json (owner-only).
import { Near, generateKey } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAINNET } from "../src/config.ts";

const [parent, name, amount, flag] = process.argv.slice(2);
if (!parent || !name || !(Number(amount) > 0)) throw new Error("usage: create-pool-account.ts <parent.near> <name> <near> [--send]");
const child = `${name}.${parent}`;
const dir = join(homedir(), ".near-credentials", "mainnet");
const near = new Near({ network: "mainnet", rpcUrl: MAINNET.rpc, keyStore: new FileKeyStore(join(homedir(), ".near-credentials"), "mainnet") });

const view = async (account_id: string) => (await (await fetch(MAINNET.rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id } }) })).json())?.result;
const p = await view(parent);
if (!p) throw new Error(`${parent} doesn't exist`);
if (await view(child)) throw new Error(`${child} already exists`);
if (!existsSync(join(dir, `${parent}.json`))) throw new Error(`no key for ${parent}: run  npx tsx bin/import-key.ts ${parent}  first`);
const bal = Number(BigInt(p.amount) / 10n ** 20n) / 1e4;
console.log(`${parent}: ${bal} NEAR. Will create ${child} with ${amount} NEAR and a new full-access key.`);
if (bal < Number(amount) + 0.05) throw new Error(`${parent} needs at least ${Number(amount) + 0.05} NEAR`);
if (flag !== "--send") { console.log("dry run: nothing sent. Re-run with --send."); process.exit(0); }

const kp = generateKey();
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${child}.json`);
// Save first: if the transaction lands, the key is already on disk.
writeFileSync(file, JSON.stringify({ account_id: child, public_key: String(kp.publicKey), private_key: kp.secretKey }), { mode: 0o600 });
await near.transaction(parent).createAccount(child).transfer(child, `${amount} NEAR` as never).addKey(String(kp.publicKey), { type: "fullAccess" }).send();
let c = await view(child);
for (let i = 0; !c && i < 10; i++) { await new Promise((r) => setTimeout(r, 1500)); c = await view(child); } // finality lags a few seconds
if (!c) { console.log(`sent; ${child} not visible yet. Check https://nearblocks.io/address/${child}`); process.exit(0); }
console.log(`created ${child}: ${Number(BigInt(c.amount) / 10n ** 20n) / 1e4} NEAR. Key saved to ${file}.`);
console.log(`https://nearblocks.io/address/${child}`);

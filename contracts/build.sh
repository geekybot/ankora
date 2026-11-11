#!/usr/bin/env bash
# Builds the wasm the pool embeds (vault) and the sandbox tests read (pool, mocks). Order matters: vault first.
set -euo pipefail
cd "$(dirname "$0")"
# Sandbox-test variant of the pool (movable clock) first: cargo-near writes the ABI json to target/near/ankora_pool/
# regardless of --out-dir, so the production build must run last to leave the production ABI there. Never deploy it.
(cd ankora-vault && cargo near build non-reproducible-wasm)
(cd ankora-pool && cargo near build non-reproducible-wasm --features test-clock --out-dir ../target/near/ankora_pool_testclock)
for c in ankora-vault ankora-pool ankora-mocks; do (cd "$c" && cargo near build non-reproducible-wasm); done

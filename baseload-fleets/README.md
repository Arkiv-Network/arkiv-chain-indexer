# Baseload fleets

Exported Baseload worker configs, ready for the panel's **Load config** button or
`PUT /baseload` with the admin bearer token. Wallet addresses are derived from the
target deployment's `BASELOAD_MNEMONIC`, so the `walletAddress` values here are only
informative.

| File | Network | What it is |
| --- | --- | --- |
| `kalarepa-churn-fleet.json` | tiramisu (kalarepa) | 21 full-churn workers, wallets 0-20, 120 kB payloads, 60 ops/min, pool 60, random hourly windows, max gas staggered 1.5 to 2.5 gwei by wallet. Loaded 2026-09-04 and saved on the backend as `churn-fleet`. |

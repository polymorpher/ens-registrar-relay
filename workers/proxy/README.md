# cloudflare-worker-proxy

Deploys a Cloudflare Worker that serves a custom hostname by reverse-proxying every request to an
upstream origin. Everything deployment-specific comes from a `.env` file in this directory, so the
same code serves any number of `hostname -> upstream` pairs.

## When to use it

- The upstream is a Worker (or any proxied hostname) in **another Cloudflare account**. A proxied
  CNAME to it fails with **Error 1014 (CNAME Cross-User Banned)**, and `*.workers.dev` cannot be a
  CNAME target from a non-Cloudflare DNS server either (Error 1001). Workers Custom Domains need the
  zone and the Worker in the same account.
- You want a `.country` (or any Cloudflare-hosted) domain to front a site hosted elsewhere without
  changing the address bar.

A plain HTTP `fetch` from a Worker has none of those restrictions, so the Worker owns the custom
domain and forwards traffic.

## Configure

```bash
cp .env.example .env
```

| Key | Meaning |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the DNS zone of `PROXY_HOSTNAME` |
| `CLOUDFLARE_API_TOKEN` | Token for that account: `Workers Scripts: Edit` (account), `Workers Routes: Edit` and `DNS: Edit` (zone). Optional if you have run `wrangler login` |
| `WORKER_NAME` | Worker name in Cloudflare. Reuse it to update an existing deployment |
| `PROXY_HOSTNAME` | Public hostname to serve; a zone in the account, or a subdomain of one |
| `UPSTREAM_URL` | Origin to forward to: scheme + host, no path |

`.env` (and `.env.*`) are git-ignored by the repo; only `.env.example` is tracked.

## Deploy

```bash
yarn install
yarn deploy                       # uses .env
ENV_FILE=.env.other yarn deploy   # another hostname -> upstream pair
yarn deploy --dry-run --outdir /tmp/out
```

`run.js` validates the env file, writes `wrangler.generated.json` (git-ignored) and runs
`wrangler <command> --config wrangler.generated.json`, so any wrangler flags can be appended.
Wrangler creates the DNS record and certificate for `PROXY_HOSTNAME`; any pre-existing DNS record
for that name must be removed first.

## Operate

```bash
yarn dev      # local server on :8787 forwarding to UPSTREAM_URL
yarn tail     # live request logs of the deployed Worker
```

## What the Worker does

- Forwards method, headers, body and WebSocket upgrades unchanged; only the host changes.
- Adds `X-Forwarded-Host: <PROXY_HOSTNAME>` so the upstream can build correct absolute URLs.
- Rewrites `Location` headers that point at the upstream host so visitors stay on the public
  hostname.
- Does not rewrite response bodies. Absolute upstream links hardcoded in HTML still leak.

## Deployments

| `.env` | Worker | Hostname | Upstream |
| --- | --- | --- | --- |
| `.env` | `governors-country-proxy` | `governors.country` | `harmony-governor-agreements.humanprotocol.workers.dev` |

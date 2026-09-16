#!/usr/bin/env node
// Builds a wrangler config from an env file, then runs wrangler with it.
//
//   node run.js <wrangler command> [wrangler args]
//   ENV_FILE=.env.other node run.js deploy
//
// Wrangler config files cannot read environment variables, and its CLI flags cannot express a
// custom domain, so the config is generated (wrangler.generated.json, git-ignored) on every run.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const root = dirname(fileURLToPath(import.meta.url))
const envFile = resolve(root, process.env.ENV_FILE ?? '.env')
const generatedConfig = resolve(root, 'wrangler.generated.json')

const fail = (message) => {
  console.error(`[proxy] ${message}`)
  process.exit(2)
}

const [command, ...wranglerArgs] = process.argv.slice(2)
if (!command) {
  fail('usage: node run.js <wrangler command> [args]   e.g. node run.js deploy --dry-run')
}

if (!existsSync(envFile)) {
  fail(`${envFile} not found. Copy .env.example to .env and fill it in, or set ENV_FILE.`)
}
// Read the file directly rather than into process.env: keys like PROXY_HOSTNAME must not be
// shadowed by whatever the shell happens to export.
const fileEnv = dotenv.parse(readFileSync(envFile))

const missing = ['WORKER_NAME', 'PROXY_HOSTNAME', 'UPSTREAM_URL'].filter(k => !fileEnv[k])
if (missing.length > 0) {
  fail(`missing in ${envFile}: ${missing.join(', ')}`)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(fileEnv.WORKER_NAME)) {
  fail(`WORKER_NAME must be lowercase letters, digits and dashes: ${fileEnv.WORKER_NAME}`)
}
if (!/^[a-z0-9.-]+$/i.test(fileEnv.PROXY_HOSTNAME)) {
  fail(`PROXY_HOSTNAME must be a bare hostname: ${fileEnv.PROXY_HOSTNAME}`)
}

let upstream
try {
  upstream = new URL(fileEnv.UPSTREAM_URL)
} catch (ex) {
  fail(`UPSTREAM_URL is not a valid URL: ${fileEnv.UPSTREAM_URL}`)
}
if (!['http:', 'https:'].includes(upstream.protocol) || upstream.pathname !== '/' || upstream.search || upstream.hash) {
  fail('UPSTREAM_URL must be an http(s) origin with no path, e.g. https://my-app.some-account.workers.dev')
}

const config = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: fileEnv.WORKER_NAME,
  main: 'src/index.js',
  compatibility_date: '2025-09-01',
  ...(fileEnv.CLOUDFLARE_ACCOUNT_ID ? { account_id: fileEnv.CLOUDFLARE_ACCOUNT_ID } : {}),
  // Reachable only via the custom domain; no *.workers.dev or preview copy of the proxy
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: fileEnv.PROXY_HOSTNAME, custom_domain: true }],
  vars: { UPSTREAM_URL: upstream.origin },
  observability: { enabled: true },
}
writeFileSync(generatedConfig, JSON.stringify(config, null, 2) + '\n')
console.log(`[proxy] ${config.name}: https://${fileEnv.PROXY_HOSTNAME} -> ${upstream.origin}`)

const env = {
  ...process.env,
  // Otherwise `wrangler dev` would also inject every key of the .env file as a Worker var
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
}
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (fileEnv[key]) {
    env[key] = fileEnv[key]
  }
}

const localBin = resolve(root, 'node_modules', '.bin', 'wrangler')
const wrangler = existsSync(localBin) ? localBin : 'wrangler'
const result = spawnSync(wrangler, [command, '--config', generatedConfig, ...wranglerArgs], { stdio: 'inherit', env, cwd: root })
if (result.error) {
  fail(`could not start wrangler: ${result.error.message}`)
}
process.exit(result.status ?? 1)

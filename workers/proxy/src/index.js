// Generic reverse proxy: serves a custom domain by forwarding every request to UPSTREAM_URL.
//
// Typical use: the upstream is a Worker in a different Cloudflare account. A proxied CNAME to it
// is rejected by Cloudflare (Error 1014), and *.workers.dev cannot be a CNAME target from outside
// Cloudflare either, but a plain HTTP fetch from this Worker has no such restriction.
//
// UPSTREAM_URL is a Worker var written by run.js from the .env file next to it.

export default {
  async fetch (request, env) {
    if (!env.UPSTREAM_URL) {
      return new Response('Proxy misconfigured: UPSTREAM_URL is not set', { status: 500 })
    }
    const upstream = new URL(env.UPSTREAM_URL)
    const url = new URL(request.url)
    const publicHost = url.host
    url.protocol = upstream.protocol
    url.host = upstream.host

    const upstreamRequest = new Request(url, request)
    upstreamRequest.headers.set('X-Forwarded-Host', publicHost)

    // 'manual' so an upstream redirect is returned to the browser instead of being followed here
    const response = await fetch(upstreamRequest, { redirect: 'manual' })

    const location = response.headers.get('Location')
    if (!location || !location.includes(upstream.host)) {
      return response
    }
    // Only clone when a header must change: wrapping a 101 response would drop its WebSocket
    const rewritten = new Response(response.body, response)
    rewritten.headers.set('Location', location.replaceAll(upstream.host, publicHost))
    return rewritten
  }
}

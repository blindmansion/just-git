# CORS Proxy

Stateless HTTP proxy that enables browser-based just-git clients to clone, fetch, and push against Git hosts like GitHub that don't serve CORS headers.

GitHub's git smart HTTP endpoints actively reject browser `OPTIONS` preflight requests (405), so direct `fetch()` calls from the browser fail. The proxy sits between the browser and the upstream host, forwarding only legitimate git operations, validating redirects, and injecting the CORS headers the browser requires.

```ts
import { createProxy } from "just-git/proxy";
```

- [Quick start](#quick-start)
- [Client setup](#client-setup)
- [Configuration](#configuration)
- [Security](#security)
- [Deployment](#deployment)
- [How it works](#how-it-works)

## Quick start

```ts
import { createProxy } from "just-git/proxy";

const proxy = createProxy({
  allowed: ["github.com"],
});

Bun.serve({ fetch: proxy.fetch, port: 9999 });
```

Browser clients can now clone public GitHub repos through `http://localhost:9999/github.com/user/repo.git`.

## Client setup

Use the `corsProxy` helper to build a `NetworkPolicy` that rewrites URLs through the proxy:

```ts
import { createGit } from "just-git";
import { corsProxy } from "just-git/proxy";

const git = createGit({
  network: corsProxy("https://proxy.example.com"),
});

// Standard GitHub URLs work — the client rewrites them automatically:
await git.exec("clone https://github.com/user/repo /work", { fs, cwd: "/" });
```

`corsProxy("https://proxy.example.com")` returns a `NetworkPolicy` whose `fetch` function rewrites `https://github.com/user/repo` to `https://proxy.example.com/github.com/user/repo`. The proxy extracts the upstream host from the first path segment and forwards the request.

Auth credentials set via `createGit({ credentials })` are forwarded through the proxy to the upstream host as `Authorization` headers.

## Configuration

```ts
const proxy = createProxy({
  // Required — upstream hosts the proxy will forward to.
  // Prevents the proxy from being used as an open relay.
  allowed: ["github.com", "gitlab.com"],

  // CORS Access-Control-Allow-Origin value.
  // String, "*", or array of allowed origins. Default: "*"
  allowOrigin: "https://myapp.com",

  // Authenticate proxy requests before forwarding.
  // Return void to allow, or a Response to reject.
  auth: (request) => {
    const key = request.headers.get("x-api-key");
    if (key !== process.env.PROXY_API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
  },

  // Custom fetch function for upstream requests. Default: globalThis.fetch
  fetch: customFetch,

  // User-Agent header sent upstream.
  // GitHub requires User-Agent to start with "git/" for proper behavior.
  // Default: "git/just-git-proxy"
  userAgent: "git/just-git-proxy",

  // Hosts to connect to via http:// instead of https://.
  insecureHosts: ["my-internal-git.local"],

  // Node adapter request size limits. Default: 512 MiB
  limits: {
    maxRequestBytes: 128 * 1024 * 1024,
  },

  // Redirect handling. Default: { mode: "follow", maxHops: 5 }
  redirects: {
    mode: "follow",
    maxHops: 3,
  },
});
```

### `allowed`

**Required.** Array of upstream hostnames the proxy will forward to. Any request targeting a host not in this list receives a 403. This is the primary defense against the proxy being used as an open relay.

### `allowOrigin`

Controls the `Access-Control-Allow-Origin` response header:

- `"*"` (default) — allow any origin.
- `"https://myapp.com"` — allow a single origin.
- `["https://a.com", "https://b.com"]` — allow multiple origins. The proxy reflects the matching request origin. A mismatched `Origin` is rejected with 403. Requests without an `Origin` header still work, but no `Access-Control-Allow-Origin` header is added.

### `auth`

Optional callback to authenticate proxy requests. Receives the raw `Request` and can return a `Response` to short-circuit (e.g. 401). CORS headers are added to auth rejection responses automatically.

### `userAgent`

The `User-Agent` header sent to the upstream server. Defaults to `"git/just-git-proxy"`. GitHub requires this to start with `git/` for proper smart HTTP behavior — without it, some endpoints return incorrect content types.

### `insecureHosts`

Hosts listed here are connected to via `http://` instead of `https://`. All other hosts default to `https://`.

### `limits.maxRequestBytes`

Maximum request body size accepted by the Node.js adapter. The default is `512 * 1024 * 1024` bytes (512 MiB).

The web-standard `fetch` handler streams request bodies directly. The Node.js adapter also streams request bodies now, but still enforces this limit for safety and returns `413 Request body too large` when it is exceeded.

### `redirects`

Controls upstream redirect handling:

- `mode: "follow"` (default) — manually follows redirects that stay within the proxy's allowlist and still point to valid git smart HTTP endpoints.
- `mode: "error"` — rejects any upstream redirect with `502`.
- `maxHops` — maximum number of redirect hops to follow. Default: `5`.

## Security

The proxy validates every request before forwarding:

- **Host allowlist**: only hosts in `allowed` are reachable. Everything else gets 403.
- **Git operation filter**: only git smart HTTP requests are forwarded:
  - `GET */info/refs?service=git-upload-pack` or `git-receive-pack`
  - `POST */git-upload-pack` with the correct content type
  - `POST */git-receive-pack` with the correct content type
  - `OPTIONS` for CORS preflight
- All other methods, paths, and content types are rejected with 403.
- **Auth hook**: add API key checks, rate limiting, or session validation.
- **Redirect validation**: redirect targets are checked against `allowed`, `insecureHosts`, and the smart HTTP endpoint rules before the proxy follows them.
- **CORS/cache safety**: responses include `Vary` headers for `Origin`, `Authorization`, and `Git-Protocol` where appropriate so shared caches do not mix variants across callers.

The proxy never parses or inspects pack data — it forwards the upstream response body as a stream.

## Deployment

### Bun

```ts
import { createProxy } from "just-git/proxy";

const proxy = createProxy({ allowed: ["github.com"] });
Bun.serve({ fetch: proxy.fetch, port: 9999 });
```

### Node.js

```ts
import http from "node:http";
import { createProxy } from "just-git/proxy";

const proxy = createProxy({ allowed: ["github.com"] });
http.createServer(proxy.nodeHandler).listen(9999);
```

The `nodeHandler` streams both request and response bodies. This keeps large pushes from being fully buffered in memory while still enforcing `limits.maxRequestBytes`.

### Cloudflare Workers / Deno Deploy

```ts
import { createProxy } from "just-git/proxy";

const proxy = createProxy({ allowed: ["github.com"] });
export default { fetch: proxy.fetch };
```

### Alongside a just-git server

You can serve the proxy and a just-git server from the same process by routing on the URL:

```ts
import { createServer } from "just-git/server";
import { createProxy } from "just-git/proxy";

const server = createServer({ autoCreate: true, basePath: "/git" });
const proxy = createProxy({ allowed: ["github.com"] });

Bun.serve({
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/git/")) return server.fetch(req);
    return proxy.fetch(req);
  },
});
```

## How it works

The proxy uses the same URL scheme as isomorphic-git's CORS proxy: the upstream domain is the first path segment of the request URL.

```
Browser request:  GET  https://proxy.example.com/github.com/user/repo.git/info/refs?service=git-upload-pack
Upstream request: GET  https://github.com/user/repo.git/info/refs?service=git-upload-pack
```

For every forwarded request, the proxy:

1. Validates the request is a legitimate git operation
2. Checks the upstream host against the `allowed` list
3. Validates the browser `Origin` against `allowOrigin` when configured
4. Runs the `auth` hook if configured, including for preflight `OPTIONS` requests
5. Rewrites `User-Agent` to `git/just-git-proxy` (required by GitHub)
6. Forwards `Authorization`, `Content-Type`, `git-protocol`, and other headers
7. Optionally follows validated upstream redirects
8. Streams the upstream response body directly to the client
9. Adds CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Expose-Headers`) and `Vary` headers to the response

Preflight `OPTIONS` requests are handled entirely by the proxy — they never reach the upstream server — but they still go through request validation and the optional `auth` hook.

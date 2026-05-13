import "dotenv/config";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Hex } from "viem";

const PRIVATE_KEY = process.env.SESSION_PRIVATE_KEY as Hex | undefined;
const RPC_URL = process.env.BASE_RPC_URL;
const UPSTREAM = process.env.UPSTREAM_BASE_URL ?? "https://tx402.ai";
const PORT = Number(process.env.PORT ?? 8787);
// Max USDC (6 decimals) the proxy will spend per request. Default: 0.10 USDC.
const MAX_VALUE = BigInt(process.env.MAX_VALUE ?? "100000");

if (!PRIVATE_KEY) {
  console.error("Missing SESSION_PRIVATE_KEY env var (0x-prefixed hex).");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});
const signer = toClientEvmSigner(account, publicClient);

const client = new x402Client()
  .register("eip155:8453", new ExactEvmScheme(signer))
  .registerPolicy((_version, reqs) =>
    reqs.filter((r) => BigInt(r.amount) <= MAX_VALUE),
  );

const paidFetch = wrapFetchWithPayment(fetch, client);

const app = express();
app.use(express.json({ limit: "10mb" }));

const PROXIED_PREFIXES = ["/v1/", "/health", "/.well-known/"];

/** Upstream (tx402 / CDN) dropped the connection while fetch was reading the body. */
function isUndiciUpstreamSocketClose(err: unknown): boolean {
  if (!(err instanceof TypeError) || err.message !== "terminated") return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  return cause?.code === "UND_ERR_SOCKET";
}

/** Client disconnected from the proxy before the full body was written (timeouts, abort, agent cancel). */
function isClientDisconnectedPrematureClose(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : "";
  if (code !== "ERR_STREAM_PREMATURE_CLOSE") return false;
  const stack = err instanceof Error ? err.stack ?? "" : "";
  return stack.includes("onServerResponseClose");
}

function logProxyFailure(err: unknown, upstreamUrl: string, clientLabel: string): void {
  if (isUndiciUpstreamSocketClose(err)) {
    console.warn(
      "upstream closed TLS socket mid-request (CDN timeout, reset, or server close). Not your agent:",
      upstreamUrl,
    );
    return;
  }
  if (isClientDisconnectedPrematureClose(err)) {
    console.warn("client disconnected before response finished:", clientLabel);
    return;
  }
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
  if (code === "ERR_STREAM_PREMATURE_CLOSE") {
    console.warn("stream closed before response finished:", upstreamUrl);
    return;
  }
  console.error("proxy error:", err);
}

app.use(async (req, res, next) => {
  if (!PROXIED_PREFIXES.some((p) => req.path === p.replace(/\/$/, "") || req.path.startsWith(p))) {
    return next();
  }

  const upstreamUrl = `${UPSTREAM}${req.originalUrl}`;
  try {
    const upstreamRes = await paidFetch(upstreamUrl, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : JSON.stringify(req.body),
    });

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return;
      res.setHeader(key, value);
    });

    if (!upstreamRes.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstreamRes.body as never);
    await pipeline(body, res);
  } catch (err) {
    const clientLabel = `${req.method} ${req.originalUrl} ← ${req.socket.remoteAddress ?? "?"}`;
    logProxyFailure(err, upstreamUrl, clientLabel);
    if (!res.headersSent) {
      res.status(502).json({ error: (err as Error).message });
    } else if (!res.writableEnded) {
      res.destroy(err as Error);
    }
  }
});

app.listen(PORT, () => {
  console.log(
    `x402 proxy → ${UPSTREAM} on http://localhost:${PORT} (signer ${account.address})`,
  );
});

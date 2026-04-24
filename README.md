# x402-proxy

Run this proxy locally and point any agent framework at it. It handles USDC payments to [tx402.ai](https://tx402.ai) automatically — no API keys, no accounts, no changes to your agent code.

## Setup

```bash
npm install
cp .env.example .env
# set SESSION_PRIVATE_KEY in .env to a wallet funded with USDC on Base
npm run dev
```

That's it. The proxy is now running at `http://localhost:8787`.

Most models cost $0.0001–$0.003 per request — $5 of USDC goes a long way.

## Agent framework config

Point your framework's OpenAI-compatible provider to `http://localhost:8787/v1.

**nanobot** (`~/.nanobot/config.json`):
```json
{
  "providers": {
    "custom": { "apiKey": "x402", "apiBase": "http://localhost:8787/v1" }
  },
  "agents": {
    "defaults": { "provider": "custom", "model": "deepseek/deepseek-v3.2" }
  }
}
```

**Hermes** (`~/.hermes/config.yaml`):
```yaml
model:
  provider: custom
  base_url: http://localhost:8787/v1
  api_key: x402
  default: deepseek/deepseek-v3.2
```

**OpenClaw** (`~/.openclaw/openclaw.json`):
```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "tx402": {
        "baseUrl": "http://localhost:8787/v1",
        "apiKey": "x402",
        "api": "openai-completions",
        "models": [{ "id": "deepseek/deepseek-v3.2", "name": "DeepSeek V3.2" }]
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "tx402/deepseek/deepseek-v3.2" } }
  }
}
```

Available models: `deepseek`, `qwen`, `kimi`, `llama`, `glm`, `gpt-oss`, and more. Full list and per-token pricing at [tx402.ai/llms.txt](https://tx402.ai/llms.txt).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SESSION_PRIVATE_KEY` | yes | — | 0x-prefixed private key of the paying wallet |
| `UPSTREAM_BASE_URL` | no | `https://tx402.ai` | x402-gated gateway to proxy to |
| `BASE_RPC_URL` | no | viem public RPC | Custom Base RPC endpoint |
| `PORT` | no | `8787` | Local port to listen on |
| `MAX_VALUE` | no | `100000` | Per-request USDC spend cap in base units (6 decimals). Default = $0.10 |

## Security

Use a dedicated wallet funded with a small float — not your main wallet. `MAX_VALUE` (default $0.10) is enforced before any payment is signed, so a misbehaving agent can't drain more than that per call.

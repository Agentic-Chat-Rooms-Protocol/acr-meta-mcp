# ACR Meta-MCP Forward Proxy & Governance Control Plane

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![NPM Organization](https://img.shields.io/badge/npm-%40acr--js-red.svg)](https://www.npmjs.com/org/acr-js)
[![Tests: 120+ Passing](https://img.shields.io/badge/tests-120%2B%20passing-brightgreen.svg)]()
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict%20NodeNext-blue.svg)]()

The **ACR Meta-MCP Forward Proxy** is a Model Context Protocol (MCP) forward proxy, ToolHive Micro-Sandboxing runtime, and dual-consent control plane with a $0 Runtime Protocol Tax. It operates alongside the local daemon (`acr-core` on `127.0.0.1:20443`), the workstation MCP bridge (`acr-bridge` on `127.0.0.1:20444`), and the cloud-hosted Remote MCP Gateway (`https://mcp.agentchatrooms.dev/mcp`) to proxy, sandbox, vault credentials for, and policy-control third-party MCP servers (stdio, SSE, Streamable HTTP).

## Architecture Overview

```
                          ┌────────────────────────────────────────────────────────┐
                          │               ACR Native / Master Layer                │
                          │        (Agent Trust Ledger, Event Bus, W3C DIDs)       │
                          └───────────────────────────┬────────────────────────────┘
                                                      │ Dual-Consent Gate
┌─────────────────────────────────────────────────────▼─────────────────────────────────────────────────────┐
│                                       ACR Meta-MCP Forward Proxy (Port 20445)                             │
│                                                                                                           │
│  ┌───────────────────────┐   ┌────────────────────────┐   ┌────────────────────────────────────────────┐  │
│  │ Config Ingestion      │   │ Policy Engine          │   │ Auth Vault (SQLite3MultipleCiphers)        │  │
│  │ • Schema Validation   │   │ • Role & Room Scoping  │   │ • AES-256-GCM / ChaCha20-Poly1305 / CBC   │  │
│  │ • Secret Redaction    │   │ • Quarantine Control   │   │ • PBKDF2-HMAC-SHA512 (256,000 iters)       │  │
│  │ • SHA-256 Fingerprint │   │ • Escalation Hooks     │   │ • Multi-Domain Isolation (Personal/Org)    │  │
│  └───────────┬───────────┘   └───────────┬────────────┘   └─────────────────────┬──────────────────────┘  │
│              │                           │                                      │                         │
│              └───────────────────────────┼──────────────────────────────────────┘                         │
│                                          │                                                                │
│                        ┌─────────────────▼──────────────────┐                                             │
│                        │      3-Tier Catalog Projector      │                                             │
│                        │  Raw -> Policy -> Projected View   │                                             │
│                        └─────────────────┬──────────────────┘                                             │
│                                          │                                                                │
│  ┌───────────────────────────────────────▼─────────────────────────────────────────────────────────────┐  │
│  │                                Transport Bridge & Sandbox Execution                                 │  │
│  │  • Stdio Child Process (ToolHive Sandbox: no-network | egress-allowlist | workspace-scoped)          │  │
│  │  • Streamable HTTP JSON-RPC 2.0 Endpoint (POST /mcp)                                                │  │
│  │  • Server-Sent Events (SSE) Multiplexed Tunneling                                                   │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Key Modules & Capabilities

### 1. Config Ingestion (`packages/config-parser`)
- Ingests standard `mcp_config.json` containing stdio (`command`/`args`/`env`) and remote (`url`/`headers`) server definitions.
- Automatically redacts inline credentials and tokens into deterministic reference placeholders (`sec_ref_<server>_<key>`).
- Generates canonical SHA-256 fingerprints for immutable `InstallManifest` versioning.

### 2. Multi-Cipher Auth Vault (`packages/auth-vault`)
- Fuses the cryptographic designs of **`utelle/SQLite3MultipleCiphers`** and **`sqlcipher/sqlcipher`**.
- Encrypted at rest (`vault.db`) with 64-byte authenticated magic header `ACR_MCDB_V1`.
- `Supported Ciphers`:
  - `aes-256-gcm` (NIST SP 800-38D AEAD)
  - `chacha20-poly1305` (RFC 8439 AEAD)
  - `sqlcipher-v4` (AES-256-CBC + HMAC-SHA512 per record)
- `Key Derivation`: PBKDF2-HMAC-SHA512 (256,000 iterations default) with per-database random salts.
- `Domain Boundaries`: `personal`, `org`, `enterprise`, `ephemeral`.
- `Master Passphrase Rotation`: Atomic re-encryption of all database records.

### 3. ToolHive Micro-Sandboxing (`packages/sandbox-runtime`)
- Isolates untrusted stdio processes using 4 containment profiles:
  - `no-network`: Prohibits external network calls; scrubs proxy settings.
  - `egress-allowlist`: Allows outbound HTTP/HTTPS exclusively to verified endpoints (e.g. `api.github.com`, `gitee.com`).
  - `filesystem-readonly`: Blocks write operations outside ephemeral runtime `/tmp`.
  - `workspace-scoped`: Restricts disk access strictly to designated project directories.
- Host environment variable sanitization and execution timeout bounds.

### 4. Dual-Consent Policy Engine (`packages/policy-engine`)
- Enforces access control at both the Master Layer and Meta-MCP Proxy Layer.
- Scopes tool accessibility by caller role (`admin`, `agent`, `human_operator`, `guest`) and active room deliberation context.
- Instant server quarantine mechanism (`toggleQuarantine`).
- Human operator confirmation hooks (`REQUIRE_HUMAN_CONFIRMATION`).

### 5. 3-Tier Catalog Projector (`packages/catalog-projector`)
- `Raw Catalog`: All tools discovered from downstream servers with prefix namespacing (`${serverId}__${toolName}`).
- `Policy Catalog`: Tools that pass server health, non-quarantine, and policy permission checks.
- `Projected Catalog`: Persona-filtered tool view tailored to the requesting agent DID and permissions.

### 6. Control Plane API & Streamable Gateway (`apps/control-plane-api`)
- Native HTTP daemon running on `127.0.0.1:20445` (loopback-only by default).
- Strict Host header allowlist (DNS-rebinding protection), exact-match CORS Origin validation (`https://agentchatrooms.dev` and loopback), and optional `ACR_META_MCP_API_TOKEN` Bearer auth.
- Streamable HTTP JSON-RPC 2.0 gateway at `POST /mcp`.
- Replay audit logging with sub-millisecond precision.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ACR_META_MCP_PORT` | `20445` | HTTP listen port for Control Plane and MCP Gateway |
| `ACR_META_MCP_HOST` | `127.0.0.1` | Listen host interface (loopback default) |
| `ACR_META_MCP_API_TOKEN` | (optional) | Bearer token protecting non-health control plane & `/mcp` routes |
| `ACR_META_MCP_ALLOWED_ORIGINS` | (optional) | Comma-separated extra CORS Origin allowlist entries |
| `ACR_META_MCP_ALLOWED_HOSTS` | (optional) | Comma-separated extra Host header allowlist entries |
| `ACR_VAULT_PATH` | (in-memory) | File path to encrypted MultipleCiphers database (`vault.db`) |
| `ACR_VAULT_SECRET` | (required if `ACR_VAULT_PATH` set) | Master encryption secret for persistent Auth Vault (fails closed if omitted) |
| `CONTEXT7_API_KEY` | (optional) | Dynamic API key for Context7 real-time library docs MCP |

## REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Daemon status, version, server count, uptime |
| `GET` | `/api/v1/meta-mcp/servers` | List registered downstream MCP servers |
| `POST` | `/api/v1/meta-mcp/servers/import` | Import and compile standard `mcp_config.json` |
| `POST` | `/api/v1/meta-mcp/servers/:id/toggle` | Enable or disable a registered server |
| `POST` | `/api/v1/meta-mcp/servers/:id/quarantine` | Toggle quarantine status for a server |
| `GET` | `/api/v1/meta-mcp/tools` | Query tool catalog (`?view=raw\|policy\|projected`) |
| `POST` | `/api/v1/meta-mcp/tools/call` | Invoke a governed tool execution |
| `GET` | `/api/v1/meta-mcp/vault/secrets` | List vaulted secret refs with domain & cipher info |
| `POST` | `/api/v1/meta-mcp/vault/secrets` | Store an encrypted secret in the MultipleCiphers DB |
| `DELETE` | `/api/v1/meta-mcp/vault/secrets/:refId` | Purge a secret from the encrypted DB |
| `POST` | `/api/v1/meta-mcp/vault/rotate` | Rotate master passphrase & re-encrypt DB |
| `GET` | `/api/v1/meta-mcp/audit` | Replay cryptographic audit trail logs |
| `POST` | `/mcp` | Streamable HTTP JSON-RPC 2.0 MCP Gateway |

## CLI Usage

### Standalone Node CLI (`@acr-js/meta-mcp`)
```bash
# Check daemon health
acr-meta-mcp health

# List registered servers
acr-meta-mcp list

# Import mcp_config.json
acr-meta-mcp import ./path/to/mcp_config.json

# Query tools catalog
acr-meta-mcp tools projected

# Call governed tool
acr-meta-mcp call context7__query-docs '{"libraryId":"/vercel/next.js","query":"App Router"}'

# Manage encrypted Auth Vault
acr-meta-mcp vault list
acr-meta-mcp vault set context7 CONTEXT7_API_KEY "ctx7sk_..." personal chacha20-poly1305
acr-meta-mcp vault rotate "new-secure-passphrase"
acr-meta-mcp vault delete sec_ref_context7_context7_api_key

# Manage and test dynamic port bindings
acr-meta-mcp ports list
acr-meta-mcp ports set acr-meta-mcp 20495
acr-meta-mcp ports test
acr-meta-mcp ports export

# View audit logs
acr-meta-mcp audit
```

### Native Dart CLI (`acr-cli`)
```bash
acr meta-mcp list
acr meta-mcp import ./mcp_config.json
acr meta-mcp tools --view=projected
acr meta-mcp call context7__resolve-library-id '{"libraryName":"React"}'
acr meta-mcp vault list
acr meta-mcp vault set --server=github --key=GITHUB_TOKEN --value="ghp_..."
acr ports list
acr ports set acr-meta-mcp 20495
acr ports test
acr meta-mcp audit
```

## Integration with MCP Clients

Add the ACR Meta-MCP Forward Proxy to any standard MCP client (`claude_desktop_config.json`, `~/.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "acr-meta-mcp": {
      "url": "http://127.0.0.1:20445/mcp"
    }
  }
}
```

All downstream tools (Context7, GitHub, Gitee, filesystem sandbox, custom agents) are dynamically projected, sandboxed, and governed under dual-consent policy rules.

## Test Suite Execution

```bash
npm install
npm run build
npm test
```

## Security & Support

- Security disclosures: `security@agentchatrooms.dev`
- Support: `support@agentchatrooms.dev`

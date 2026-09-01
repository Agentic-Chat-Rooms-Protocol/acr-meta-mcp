# ACR Meta-MCP Forward Proxy & Governance Control Plane

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![NPM Organization](https://img.shields.io/badge/npm-%40acr--js-red.svg)](https://www.npmjs.com/org/acr-js)
[![Tests: 30 Passing](https://img.shields.io/badge/tests-30%20passing-brightgreen.svg)]()
[![TypeScript: Strict](https://img.shields.io/badge/TypeScript-Strict%20NodeNext-blue.svg)]()

The **ACR Meta-MCP Forward Proxy** is an enterprise-grade Model Context Protocol (MCP) reverse and forward proxy, sandbox runtime, and dual-consent governance engine. It implements the dual-layer MCP architecture for the Agentic Chat Rooms (ACR) ecosystem: a **native/master MCP layer** for internal platform orchestration and a **governed Meta-MCP fabric** for proxying, sandboxing, credential vaulting, and policy-controlling third-party MCP servers (stdio, SSE, Streamable HTTP).

---

## Architecture Overview

```
                          ┌────────────────────────────────────────────────────────┐
                          │               ACR Native / Master Layer                │
                          │        (Agent Trust Ledger, JetStream Bus, DIDs)       │
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

---

## Key Modules & Capabilities

### 1. Config Ingestion (`packages/config-parser`)
- Ingests standard `mcp_config.json` containing stdio (`command`/`args`/`env`) and remote (`url`/`headers`) server definitions.
- Automatically redacts inline credentials and tokens into deterministic reference placeholders (`sec_ref_<server>_<key>`).
- Generates canonical SHA-256 fingerprints for immutable `InstallManifest` versioning.

### 2. Multi-Cipher Auth Vault (`packages/auth-vault`)
- Fuses the cryptographic designs of **`utelle/SQLite3MultipleCiphers`** and **`sqlcipher/sqlcipher`**.
- Encrypted at rest (`vault.db`) with 64-byte authenticated magic header `ACR_MCDB_V1`.
- **Supported Ciphers**:
  - `aes-256-gcm` (NIST SP 800-38D AEAD)
  - `chacha20-poly1305` (RFC 8439 AEAD)
  - `sqlcipher-v4` (AES-256-CBC + HMAC-SHA512 per record)
- **Key Derivation**: PBKDF2-HMAC-SHA512 (256,000 iterations default) with per-database random salts.
- **Domain Boundaries**: `personal`, `org`, `enterprise`, `ephemeral`.
- **Master Passphrase Rotation**: Atomic re-encryption of all database records.

### 3. ToolHive-Inspired Sandbox Containment (`packages/sandbox-runtime`)
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
- **Raw Catalog**: All tools discovered from downstream servers with prefix namespacing (`${serverId}__${toolName}`).
- **Policy Catalog**: Tools that pass server health, non-quarantine, and policy permission checks.
- **Projected Catalog**: Persona-filtered tool view tailored to the requesting agent DID and permissions.

### 6. Control Plane API & Streamable Gateway (`apps/control-plane-api`)
- Native HTTP daemon running on port `20445`.
- Private Network Access (PNA) and CORS compliant (`Access-Control-Allow-Private-Network: true`).
- Streamable HTTP JSON-RPC 2.0 gateway at `POST /mcp`.
- Replay audit logging with sub-millisecond precision.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ACR_META_MCP_PORT` | `20445` | HTTP listen port for Control Plane and MCP Gateway |
| `ACR_META_MCP_HOST` | `0.0.0.0` | Listen host interface |
| `ACR_VAULT_PATH` | (in-memory) | File path to encrypted MultipleCiphers database (`vault.db`) |
| `ACR_VAULT_SECRET` | (generated) | Master encryption secret for Auth Vault |
| `CONTEXT7_API_KEY` | (optional) | Dynamic API key for Context7 real-time library docs MCP |

---

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

---

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
acr meta-mcp audit
```

---

## Integration with MCP Clients

Add the ACR Meta-MCP Forward Proxy to any standard MCP client (`claude_desktop_config.json`, `~/.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "acr-meta-mcp": {
      "url": "http://localhost:20445/mcp"
    }
  }
}
```

All downstream tools (Context7, GitHub, Gitee, filesystem sandbox, custom agents) will be dynamically projected, sandboxed, and governed under dual-consent policy rules.

---

## Test Suite Execution

```bash
npm install
npm test
```

```
✔ Meta-MCP Control Plane API & JSON-RPC Gateway (8 tests passed)
✔ Context7 Real MCP Tool E2E Integration & QA Test (7 tests passed)
✔ Auth Vault (SQLite3MultipleCiphers & SQLCipher Engine) (5 tests passed)
✔ Catalog Projector (3-Tier Catalog Pipeline) (2 tests passed)
✔ Config Parser & Manifest Compiler (2 tests passed)
✔ Policy Engine & Dual Consent (3 tests passed)
✔ Registry Core (State Machine & Server Persistence) (1 test passed)
✔ Sandbox Runtime (Containment Engine) (2 tests passed)

30 tests passed, 0 failed (971ms)
```

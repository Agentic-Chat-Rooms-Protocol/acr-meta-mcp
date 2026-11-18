# Agent Guidelines - acr-meta-mcp

## Overview & Scope
`acr-meta-mcp` is the 18th canonical repository of the ACR ecosystem. It implements the **Meta-MCP Forward Proxy, Governance Control Plane, ToolHive-Inspired Sandbox, and Multi-Cipher Auth Vault**.

---

## NPM Organization & Publishing
- **Live NPM Organization**: `@acr-js` (All packages published under `@acr-js/meta-mcp-*`).
- **Core Workspace Packages**:
  - `@acr-js/config-parser`: Config compiler, validation, secret redaction, SHA-256 fingerprinting.
  - `@acr-js/auth-vault`: SQLite3MultipleCiphers / SQLCipher isolated database engine (`aes-256-gcm`, `chacha20-poly1305`, `sqlcipher-v4`).
  - `@acr-js/sandbox-runtime`: Stdio process containment (`no-network`, `egress-allowlist`, `filesystem-readonly`, `workspace-scoped`).
  - `@acr-js/policy-engine`: Dual-consent evaluation, role-based gating, quarantine, human escalation.
  - `@acr-js/catalog-projector`: 3-tier projection (Raw -> Policy -> Projected) with prefix namespacing.
  - `@acr-js/registry-core`: Server registration store, health status, and state transitions.
  - `@acr-js/transport-bridge`: Stdio, SSE, and Streamable HTTP JSON-RPC 2.0 multiplexing.
  - `@acr-js/control-plane-api`: Port 20445 REST API & `/mcp` JSON-RPC gateway.
  - `@acr-js/cli`: Terminal management toolkit (`health`, `list`, `import`, `enable`, `disable`, `tools`, `call`, `vault`, `ports`, `audit`).

---

## Architectural Disciplines & Rules
1. **Dual-Layer MCP Separation**:
   - Master Layer (`acr-core`, `127.0.0.1:20443`) manages agent identities, consensus voting, and JetStream bus.
   - Bridge Layer (`acr-bridge`, `127.0.0.1:20444`) provides local stdio/SSE bridge transport.
   - Meta-MCP Layer (`acr-meta-mcp`, `127.0.0.1:20445`) manages external/third-party tools, containment profiles, and credential vaulting.
2. **Zero Hardcoded Secrets**:
   - Never embed raw credentials in source code. Persistent Auth Vaults (`ACR_VAULT_PATH`) fail closed when `ACR_VAULT_SECRET` / `ACR_MASTER_SECRET` is unset.
3. **Database Vault Security**:
   - Use `AcrMultipleCiphersDb` for persistent encrypted storage with `ACR_MCDB_V1` binary headers and PBKDF2-HMAC-SHA512 KDF.
4. **Dynamic Port Mapping**:
   - Default port is `20445` on loopback `127.0.0.1`. Support environment overrides (`ACR_META_MCP_PORT`, `ACR_META_MCP_HOST`, `ACR_META_MCP_API_TOKEN`) and local `~/.acr/ports.json`.
5. **Deterministic Verification**:
   - Always run `npm run build` before `npm test` (tests execute compiled `dist/`).
6. **Contacts**:
   - Security disclosures and support strictly use `@agentchatrooms.dev` (`security@agentchatrooms.dev`, `support@agentchatrooms.dev`).

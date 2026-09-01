# ACR Meta-MCP Forward Proxy & Governance Control Plane

The **ACR Meta-MCP Forward Proxy** is an enterprise-grade Model Context Protocol (MCP) proxy and governance engine. It implements the dual-layer MCP architecture for the Agentic Chat Rooms (ACR) ecosystem: a **native/master MCP layer** for internal platform orchestration and a **governed Meta-MCP fabric** for proxying, sandboxing, and policy-controlling third-party MCP servers (stdio, SSE, Streamable HTTP).

---

## Key Features

1. **Config-Ingestion Plane (`packages/config-parser`)**:
   - Ingests standard `mcp_config.json` with stdio (`command`/`args`/`env`) and remote (`url`/`headers`) server definitions.
   - Compiles immutable, versioned **Install Manifests** with SHA-256 fingerprints.
   - Automatically sanitizes and extracts sensitive credentials into the Auth Vault (`sec_ref_...`).

2. **Multi-Domain Auth Vault (`packages/auth-vault`)**:
   - AES-256-GCM authenticated credential storage.
   - Strict domain separation (`personal`, `org`, `enterprise`, `ephemeral`) preventing credential leakage across untrusted boundaries.

3. **ToolHive-Inspired Sandbox Containment (`packages/sandbox-runtime`)**:
   - Isolates untrusted stdio processes with containment profiles (`no-network`, `egress-allowlist`, `filesystem-readonly`, `workspace-scoped`).
   - Host environment variable scrubbing and timeout enforcement.

4. **Dual-Consent Policy Engine (`packages/policy-engine`)**:
   - Independent verification gates for server reachability and tool execution.
   - Role-based and room-based scoping (`admin`, `agent`, `human_operator`, `guest`).
   - Human operator escalation hooks (`REQUIRE_HUMAN_CONFIRMATION`).
   - Instant server quarantine mechanism.

5. **3-Tier Catalog Projector (`packages/catalog-projector`)**:
   - **Raw Catalog**: All downstream tools with server namespace prefixes (`${serverId}__${toolName}`).
   - **Policy Catalog**: Active, non-quarantined, and policy-permitted tools.
   - **Projected Catalog**: Persona-tailored tool projection for specific requesting agent DIDs.

6. **Control-Plane API & Streamable HTTP Gateway (`apps/control-plane-api`)**:
   - High-performance native HTTP daemon on port `20445`.
   - Private Network Access (PNA) and CORS compliant.
   - Streamable HTTP JSON-RPC 2.0 endpoint at `POST /mcp`.
   - Replay audit logger tracking all events with sub-millisecond precision.

7. **CLI Parity (`apps/cli` & `acr-cli`)**:
   - Complete terminal management: `acr meta-mcp list`, `import`, `enable`, `disable`, `tools`, `call`, `audit`.

8. **Hyper-Premium Web Studio (`MetaMcpStudio.tsx`)**:
   - WCAG 2.2 AA compliant, keyboard accessible interface integrated directly into `acr-web` and `acr-web-local`.

---

## Quick Start

### Build & Run Tests
```bash
cd src/acr-meta-mcp
npm install
npm test
```

### Launch Control Plane Daemon
```bash
npm start
# Listening on http://localhost:20445
# JSON-RPC MCP Gateway: http://localhost:20445/mcp
# REST API: http://localhost:20445/api/v1/meta-mcp/
```

### Import `mcp_config.json` via CLI
```bash
node apps/cli/dist/index.js import path/to/mcp_config.json
```

### Query Projected Tools
```bash
node apps/cli/dist/index.js tools projected
```

### Call a Governed Tool
```bash
node apps/cli/dist/index.js call gitee-cloud__create_issue '{"title": "Meta-MCP verified"}'
```

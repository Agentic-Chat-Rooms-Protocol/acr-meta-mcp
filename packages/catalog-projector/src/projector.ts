import { McpToolDefinition, PolicyCatalog, ProjectedCatalog, RawCatalog } from './types.js';

export function namespaceTool(serverId: string, originalName: string): string {
  // If already namespaced, don't duplicate
  if (originalName.startsWith(`${serverId}__`)) {
    return originalName;
  }
  const cleanServer = serverId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${cleanServer}__${originalName}`;
}

export function denamespaceTool(namespacedName: string): { serverId: string; originalName: string } {
  const parts = namespacedName.split('__');
  if (parts.length < 2) {
    return { serverId: 'default', originalName: namespacedName };
  }
  const serverId = parts[0];
  const originalName = parts.slice(1).join('__');
  return { serverId, originalName };
}

export interface CatalogProjectorOptions {
  isServerEnabled?: (serverId: string) => boolean;
  isToolEnabled?: (toolName: string) => boolean;
  isServerQuarantined?: (serverId: string) => boolean;
}

export class CatalogProjector {
  constructor(private readonly options: CatalogProjectorOptions = {}) {}

  public buildRawCatalog(
    serverToolMap: Record<string, Array<{ name: string; description?: string; inputSchema?: any }>>
  ): RawCatalog {
    const tools: McpToolDefinition[] = [];
    const serverCounts: Record<string, number> = {};

    for (const [serverId, rawTools] of Object.entries(serverToolMap)) {
      serverCounts[serverId] = rawTools.length;
      for (const t of rawTools) {
        tools.push({
          name: namespaceTool(serverId, t.name),
          originalName: t.name,
          serverId,
          description: t.description || `Tool ${t.name} from server ${serverId}`,
          inputSchema: t.inputSchema || { type: 'object' },
        });
      }
    }

    return {
      tools,
      totalDiscovered: tools.length,
      serverCounts,
      generatedAt: new Date().toISOString(),
    };
  }

  public buildPolicyCatalog(rawCatalog: RawCatalog): PolicyCatalog {
    const isServerEnabled = this.options.isServerEnabled ?? (() => true);
    const isToolEnabled = this.options.isToolEnabled ?? (() => true);
    const isServerQuarantined = this.options.isServerQuarantined ?? (() => false);

    const filtered: McpToolDefinition[] = [];

    for (const tool of rawCatalog.tools) {
      if (!isServerEnabled(tool.serverId)) continue;
      if (isServerQuarantined(tool.serverId)) continue;
      if (!isToolEnabled(tool.name)) continue;
      filtered.push(tool);
    }

    return {
      tools: filtered,
      totalPolicyAllowed: filtered.length,
      totalFiltered: rawCatalog.totalDiscovered - filtered.length,
      generatedAt: new Date().toISOString(),
    };
  }

  public projectForCaller(
    policyCatalog: PolicyCatalog,
    caller: { did: string; role: string; capabilities?: string[]; allowedPrefixes?: string[] }
  ): ProjectedCatalog {
    let visible = policyCatalog.tools;

    // Filter by allowed prefixes if configured
    if (caller.allowedPrefixes && caller.allowedPrefixes.length > 0) {
      visible = visible.filter((t) =>
        caller.allowedPrefixes!.some((prefix) => t.serverId === prefix || t.name.startsWith(`${prefix}__`))
      );
    }

    // Role-based filtering: guests only see read-only tools
    if (caller.role === 'guest') {
      visible = visible.filter((t) =>
        /get|list|read|inspect|search|find|status/i.test(t.originalName)
      );
    }

    return {
      callerDid: caller.did,
      role: caller.role,
      tools: visible,
      totalVisible: visible.length,
      generatedAt: new Date().toISOString(),
    };
  }
}

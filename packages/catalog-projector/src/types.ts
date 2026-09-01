export interface McpToolDefinition {
  name: string; // namespaced e.g. "gitee__create_issue"
  originalName: string; // original e.g. "create_issue"
  serverId: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  tags?: string[];
}

export interface RawCatalog {
  tools: McpToolDefinition[];
  totalDiscovered: number;
  serverCounts: Record<string, number>;
  generatedAt: string;
}

export interface PolicyCatalog {
  tools: McpToolDefinition[];
  totalPolicyAllowed: number;
  totalFiltered: number;
  generatedAt: string;
}

export interface ProjectedCatalog {
  callerDid: string;
  role: string;
  tools: McpToolDefinition[];
  totalVisible: number;
  generatedAt: string;
}

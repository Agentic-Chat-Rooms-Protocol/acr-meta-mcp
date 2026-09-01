export type CallerRole = 'admin' | 'agent' | 'human_operator' | 'guest';

export interface CallerIdentity {
  did: string;
  role: CallerRole;
  rooms?: string[];
  scopes?: string[];
}

export type PolicyAction = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_CONFIRMATION';

export interface ServerPolicyRule {
  serverId: string;
  enabled: boolean;
  quarantined: boolean;
  trustLevel: 'untrusted' | 'verified' | 'internal';
  allowedRoles?: CallerRole[];
  allowedRooms?: string[];
  maxCallsPerMinute?: number;
}

export interface ToolPolicyRule {
  toolName: string; // e.g. "gitee__create_issue"
  enabled: boolean;
  action: PolicyAction;
  allowedRoles?: CallerRole[];
  allowedRooms?: string[];
  requiredScopes?: string[];
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  action: PolicyAction;
  reason: string;
  layer: 'NATIVE_MASTER_GATE' | 'META_MCP_GATE';
  evaluatedAt: string;
}

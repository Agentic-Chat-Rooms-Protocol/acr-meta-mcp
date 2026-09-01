import { CallerIdentity, PolicyEvaluationResult, ServerPolicyRule, ToolPolicyRule } from './types.js';

export class PolicyEngine {
  private readonly serverPolicies = new Map<string, ServerPolicyRule>();
  private readonly toolPolicies = new Map<string, ToolPolicyRule>();

  public setServerPolicy(policy: ServerPolicyRule): void {
    this.serverPolicies.set(policy.serverId, policy);
  }

  public setToolPolicy(policy: ToolPolicyRule): void {
    this.toolPolicies.set(policy.toolName, policy);
  }

  public getServerPolicy(serverId: string): ServerPolicyRule | undefined {
    return this.serverPolicies.get(serverId);
  }

  public getToolPolicy(toolName: string): ToolPolicyRule | undefined {
    return this.toolPolicies.get(toolName);
  }

  public evaluateServerAccess(caller: CallerIdentity, serverId: string): PolicyEvaluationResult {
    const now = new Date().toISOString();
    const serverRule = this.serverPolicies.get(serverId);

    // Default policy if unconfigured
    if (!serverRule) {
      return {
        allowed: true,
        action: 'ALLOW',
        reason: `Server "${serverId}" has no explicit policy (default allow).`,
        layer: 'META_MCP_GATE',
        evaluatedAt: now,
      };
    }

    if (!serverRule.enabled) {
      return {
        allowed: false,
        action: 'DENY',
        reason: `Server "${serverId}" is disabled by administrator.`,
        layer: 'META_MCP_GATE',
        evaluatedAt: now,
      };
    }

    if (serverRule.quarantined && caller.role !== 'admin') {
      return {
        allowed: false,
        action: 'DENY',
        reason: `Server "${serverId}" is in QUARANTINE status. Only administrators may access.`,
        layer: 'META_MCP_GATE',
        evaluatedAt: now,
      };
    }

    if (serverRule.allowedRoles && !serverRule.allowedRoles.includes(caller.role)) {
      return {
        allowed: false,
        action: 'DENY',
        reason: `Caller role "${caller.role}" is not in server allowedRoles list.`,
        layer: 'NATIVE_MASTER_GATE',
        evaluatedAt: now,
      };
    }

    return {
      allowed: true,
      action: 'ALLOW',
      reason: `Server "${serverId}" access approved for ${caller.did}.`,
      layer: 'META_MCP_GATE',
      evaluatedAt: now,
    };
  }

  public evaluateToolCall(
    caller: CallerIdentity,
    serverId: string,
    toolName: string,
    roomContext?: string
  ): PolicyEvaluationResult {
    const now = new Date().toISOString();

    // Layer 1: Check Server Access
    const serverAccess = this.evaluateServerAccess(caller, serverId);
    if (!serverAccess.allowed) {
      return serverAccess;
    }

    // Layer 2: Check Specific Tool Access
    const toolRule = this.toolPolicies.get(toolName);
    if (!toolRule) {
      return {
        allowed: true,
        action: 'ALLOW',
        reason: `Tool "${toolName}" has no specific restriction.`,
        layer: 'META_MCP_GATE',
        evaluatedAt: now,
      };
    }

    if (!toolRule.enabled) {
      return {
        allowed: false,
        action: 'DENY',
        reason: `Tool "${toolName}" is explicitly disabled.`,
        layer: 'META_MCP_GATE',
        evaluatedAt: now,
      };
    }

    if (toolRule.allowedRoles && !toolRule.allowedRoles.includes(caller.role)) {
      return {
        allowed: false,
        action: 'DENY',
        reason: `Role "${caller.role}" is not authorized for tool "${toolName}".`,
        layer: 'NATIVE_MASTER_GATE',
        evaluatedAt: now,
      };
    }

    if (toolRule.allowedRooms && roomContext && !toolRule.allowedRooms.includes(roomContext)) {
      return {
        allowed: false,
        action: 'DENY',
        reason: `Tool "${toolName}" is not permitted in room "${roomContext}".`,
        layer: 'NATIVE_MASTER_GATE',
        evaluatedAt: now,
      };
    }

    if (toolRule.action === 'REQUIRE_HUMAN_CONFIRMATION' && caller.role === 'agent') {
      return {
        allowed: false,
        action: 'REQUIRE_HUMAN_CONFIRMATION',
        reason: `Tool "${toolName}" requires human operator escalation consent.`,
        layer: 'NATIVE_MASTER_GATE',
        evaluatedAt: now,
      };
    }

    return {
      allowed: true,
      action: 'ALLOW',
      reason: `Tool call "${toolName}" authorized for ${caller.did}.`,
      layer: 'META_MCP_GATE',
      evaluatedAt: now,
    };
  }
}

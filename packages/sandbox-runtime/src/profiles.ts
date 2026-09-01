import { SandboxPolicyConfig, SandboxProfileType } from './types.js';

export const DEFAULT_SANDBOX_PROFILES: Record<SandboxProfileType, SandboxPolicyConfig> = {
  'no-network': {
    profile: 'no-network',
    maxMemoryMb: 256,
    timeoutMs: 15000,
    readOnlyFilesystem: true,
    allowedEgressHosts: [],
  },
  'egress-allowlist': {
    profile: 'egress-allowlist',
    maxMemoryMb: 512,
    timeoutMs: 30000,
    readOnlyFilesystem: true,
    allowedEgressHosts: ['api.github.com', 'gitee.com', 'localhost', '127.0.0.1'],
  },
  'filesystem-readonly': {
    profile: 'filesystem-readonly',
    maxMemoryMb: 256,
    timeoutMs: 20000,
    readOnlyFilesystem: true,
  },
  'workspace-scoped': {
    profile: 'workspace-scoped',
    maxMemoryMb: 512,
    timeoutMs: 60000,
    readOnlyFilesystem: false,
    allowedWorkspacePaths: ['./workspace', './tmp'],
  },
  unrestricted: {
    profile: 'unrestricted',
    maxMemoryMb: 1024,
    timeoutMs: 120000,
    readOnlyFilesystem: false,
  },
};

export function getSanitizedEnvironment(
  customEnv: Record<string, string>,
  profile: SandboxPolicyConfig
): NodeJS.ProcessEnv {
  // Base minimal safe system environment
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    NODE_ENV: 'production',
    HOME: process.env.USERPROFILE || process.env.HOME || '',
    TEMP: process.env.TEMP || '',
    TMP: process.env.TMP || '',
    ACR_SANDBOX_PROFILE: profile.profile,
  };

  // Block sensitive host environment variables from leaking into child
  const BLOCKED_VARS = [
    'ACR_MOAT_SECRET',
    'UNKEY_ROOT_KEY',
    'AZURE_CLIENT_SECRET',
    'MACOS_CERT_PASSWORD',
    'GITHUB_TOKEN',
  ];

  for (const [k, v] of Object.entries(customEnv)) {
    if (!BLOCKED_VARS.includes(k)) {
      safeEnv[k] = v;
    }
  }

  if (profile.profile === 'no-network') {
    safeEnv.HTTP_PROXY = 'http://0.0.0.0:0';
    safeEnv.HTTPS_PROXY = 'http://0.0.0.0:0';
    safeEnv.NO_PROXY = '';
  }

  return safeEnv;
}

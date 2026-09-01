import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileInstallManifest, parseRawConfig } from '../src/index.js';

describe('Config Parser & Manifest Compiler', () => {
  it('should parse stdio and remote configs correctly', () => {
    const rawJson = JSON.stringify({
      mcpServers: {
        'github-tool': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_super_secret_token_123456789' }
        },
        'gitee-remote': {
          url: 'https://gitee.com/api/mcp',
          headers: { Authorization: 'Bearer gitee_enterprise_token_987654321' }
        }
      }
    });

    const manifest = compileInstallManifest(rawJson);

    assert.equal(manifest.totalServers, 2);
    assert.equal(manifest.servers[0].serverId, 'github-tool');
    assert.equal(manifest.servers[0].transport, 'stdio');
    assert.ok(manifest.servers[0].stdioSpec?.envRefs.GITHUB_PERSONAL_ACCESS_TOKEN.startsWith('sec_ref_'));

    assert.equal(manifest.servers[1].serverId, 'gitee-remote');
    assert.equal(manifest.servers[1].transport, 'streamable_http');
    assert.ok(manifest.servers[1].remoteSpec?.headerRefs.Authorization.startsWith('sec_ref_'));
    assert.ok(manifest.fingerprintSha256.length === 64);
  });

  it('should throw ConfigParseError on invalid JSON', () => {
    assert.throws(() => {
      parseRawConfig('{ invalid: json');
    });
  });
});

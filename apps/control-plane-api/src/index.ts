import { MetaMcpServer } from './server.js';

const PORT = parseInt(process.env.ACR_META_MCP_PORT || '20445', 10);
const HOST = process.env.ACR_META_MCP_HOST || '0.0.0.0';

const server = new MetaMcpServer();

server.start({ port: PORT, host: HOST }).catch((err) => {
  console.error('[ACR Meta-MCP] Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('\n[ACR Meta-MCP] Shutting down gracefully...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[ACR Meta-MCP] Shutting down gracefully...');
  await server.stop();
  process.exit(0);
});

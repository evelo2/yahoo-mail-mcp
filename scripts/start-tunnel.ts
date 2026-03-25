/**
 * Starts the MCP HTTP server + Cloudflare tunnel together.
 * Prints the public MCP endpoint URL clearly in the terminal.
 *
 * Usage: npx tsx scripts/start-tunnel.ts
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const PORT = process.env.MCP_HTTP_PORT || '3001';
const rootDir = resolve(import.meta.dirname, '..');

// 1. Start the MCP server
const server = spawn('node', ['dist/index.js'], {
  cwd: rootDir,
  env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HTTP_PORT: PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (data: Buffer) => {
  process.stdout.write(data);
});
server.stderr.on('data', (data: Buffer) => {
  process.stderr.write(data);
});

// Wait a beat for the server to bind
await new Promise((r) => setTimeout(r, 1500));

// 2. Start cloudflared tunnel
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let urlPrinted = false;

function checkForUrl(data: Buffer) {
  if (urlPrinted) return;
  const text = data.toString();
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match) {
    urlPrinted = true;
    const tunnelUrl = match[0];
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                                                          ║');
    console.log(`║  MCP Endpoint: ${tunnelUrl}/mcp`);
    console.log('║                                                          ║');
    console.log('║  Add this URL to Claude Chat MCP config.                 ║');
    console.log('║  Press Ctrl+C to stop.                                   ║');
    console.log('║                                                          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
  }
}

tunnel.stdout.on('data', checkForUrl);
tunnel.stderr.on('data', checkForUrl);

// Cleanup on exit
function cleanup() {
  console.log('\nShutting down...');
  tunnel.kill();
  server.kill();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// If either process dies, kill the other
server.on('exit', (code) => {
  if (code !== null) console.log(`Server exited with code ${code}`);
  tunnel.kill();
  process.exit(code ?? 1);
});

tunnel.on('exit', (code) => {
  if (code !== null) console.log(`Tunnel exited with code ${code}`);
  server.kill();
  process.exit(code ?? 1);
});

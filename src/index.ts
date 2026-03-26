import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadSenderRules, loadCustomActions } from './rules/config.js';
import { initPromptManager } from './prompt/manager.js';
import { initAuditLog } from './utils/audit-log.js';
import { initTtlStore } from './utils/ttl-store.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';
import { getRulesConfigPath, getActionsConfigPath, getPromptDir } from './utils/paths.js';
import { closeConnection } from './imap/client.js';
import { runPreflight, printPreflightReport } from './preflight.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

async function main() {
  const configPath = getRulesConfigPath();
  logger.info({ configPath }, 'Loading sender rules');

  // Load custom actions before sender rules (so rules can reference custom actions)
  const actionsConfigPath = getActionsConfigPath();
  const customActionCount = loadCustomActions(actionsConfigPath);
  if (customActionCount > 0) {
    logger.info({ customActionCount }, 'Custom actions loaded from disk');
  }

  const rules = loadSenderRules(configPath);
  logger.info({ exactRules: rules.exact.size, regexRules: rules.regex.length }, 'Sender rules loaded');

  // Initialize prompt manager (creates default prompt.md on first run)
  initPromptManager(getPromptDir());

  // Initialize audit log and TTL store
  initAuditLog(getPromptDir());
  initTtlStore(getPromptDir());

  // Run preflight checks — connect to Yahoo, enumerate inbox & folders
  const skipPreflight = process.env.SKIP_PREFLIGHT === 'true';
  if (!skipPreflight) {
    const preflight = await runPreflight();
    printPreflightReport(preflight);
    if (!preflight.success) {
      logger.fatal('Preflight checks failed. Fix configuration and restart.');
      process.exit(1);
    }
  } else {
    logger.warn('Preflight checks skipped (SKIP_PREFLIGHT=true)');
  }

  const transportMode = process.env.MCP_TRANSPORT || 'stdio';

  if (transportMode === 'stdio') {
    const server = createServer(rules);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    logger.info('MCP server running on stdio transport');
  } else if (transportMode === 'http') {
    const port = parseInt(process.env.MCP_HTTP_PORT || '3001', 10);
    const apiKey = process.env.MCP_API_KEY;

    const app = express();

    // ── Security middleware ──

    // Helmet: sets security-related HTTP headers
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],  // API server — no content to load
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
    }));

    // CORS: restrictive — no cross-origin requests allowed by default
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',').map(s => s.trim()) || [];
    app.use(cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization'],
    }));

    // Rate limiting: 100 requests per minute per IP
    app.use(rateLimit({
      windowMs: 60 * 1000,
      max: parseInt(process.env.RATE_LIMIT_RPM || '100', 10),
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests. Please try again later.' },
    }));

    app.use(express.json());

    // ── API key authentication (when MCP_API_KEY is set) ──

    if (apiKey) {
      app.use('/mcp', (req, res, next) => {
        const provided = req.headers['authorization'];
        if (provided !== `Bearer ${apiKey}`) {
          res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token in the Authorization header.' });
          return;
        }
        next();
      });
      logger.info('HTTP API key authentication enabled');
    } else {
      logger.warn('No MCP_API_KEY set — HTTP transport is unauthenticated. Set MCP_API_KEY for production use.');
    }

    // Store active transports by session ID
    const transports = new Map<string, StreamableHTTPServerTransport>();

    // Handle MCP requests (POST /mcp)
    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // If we have an existing session, reuse it
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session — create a new transport and server instance
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          logger.info({ sessionId: id }, 'New MCP session initialized');
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = [...transports.entries()].find(([_, t]) => t === transport)?.[0];
        if (sid) {
          transports.delete(sid);
          logger.info({ sessionId: sid }, 'MCP session closed');
        }
      };

      const server = createServer(rules);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    // Handle SSE streams (GET /mcp)
    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid or missing session ID. Send a POST to /mcp first.' });
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // Handle session termination (DELETE /mcp)
    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid or missing session ID.' });
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    });

    // Health check (unauthenticated — intentional)
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', transport: 'http', sessions: transports.size });
    });

    app.listen(port, () => {
      logger.info({ port }, `MCP server running on HTTP transport at http://localhost:${port}/mcp`);
      console.log(`\nYahoo Mail MCP server listening on http://localhost:${port}/mcp`);
      console.log(`Health check: http://localhost:${port}/health\n`);
    });
  } else {
    logger.error({ transport: transportMode }, 'Unsupported transport. Use "stdio" or "http".');
    process.exit(1);
  }

  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await closeConnection();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await closeConnection();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start MCP server');
  process.exit(1);
});

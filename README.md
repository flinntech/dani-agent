# DANI Agent Service

Production-ready AI Agent service using Claude and the Model Context Protocol (MCP). This service provides the core intelligence for the DANI platform, integrating Claude AI with Digi Remote Manager and service outage monitoring capabilities.

> Part of the [DANI platform](../README.md) - Digi Remote Manager and Network Infrastructure Assistant

## Features

- **Claude AI Integration**: Uses official Anthropic SDK with support for Claude Haiku and Sonnet models
- **Model Context Protocol**: Connects to MCP servers for dynamic tool discovery and execution
- **Prompt Caching**: Automatic caching of system messages and tools to reduce API costs by up to 90%
- **Multi-turn Conversations**: Stateful conversation management with automatic history trimming
- **Agentic Tool Loop**: Automatically handles multi-step tool execution
- **Model Selection**: Automatic model selection based on query complexity
- **Extended Thinking**: Support for Claude's thinking mode for analytical queries
- **Production Ready**: Docker containerization, health checks, graceful shutdown, structured logging
- **Retry Logic**: Exponential backoff for API failures and rate limits
- **AWS Secrets Manager**: Secure credential management for production deployments
- **Request Tracing**: Correlation IDs across all service calls for debugging

## Architecture

```
HTTP API (Express)
    ↓
DANI Agent Core (agent.ts)
    ↓
Claude API (with prompt caching)
    ├─> Haiku 4.5 (SIMPLE queries)
    ├─> Sonnet 4.5 (PROCEDURAL queries)
    └─> Sonnet 4.5 + Extended Thinking (ANALYTICAL queries)
    ↓
MCP Client Manager (mcp-client.ts)
    ├─> DRM MCP Server (62 tools for device management)
    └─> Outage Monitor MCP Server (8 tools for service status)
```

## Quick Start

### Prerequisites

- Node.js 20+
- Anthropic API key ([get one here](https://console.anthropic.com/))
- Access to MCP servers (DRM and Outage Monitor)

### Installation

1. **Clone and navigate:**

```bash
cd dani-agent
```

2. **Install dependencies:**

```bash
npm install
```

3. **Create environment file:**

```bash
cp .env.example .env
```

4. **Configure environment variables:**

Edit `.env` and add your configuration:

```env
ANTHROPIC_API_KEY=sk-ant-your-api-key-here
DRM_MCP_URL=http://drm-mcp-server:3001/mcp
OUTAGE_MCP_URL=http://outage-monitor-mcp:3002/mcp
LOG_LEVEL=info
NODE_ENV=production
```

5. **Build the TypeScript code:**

```bash
npm run build
```

### Running Locally

**Development mode with auto-reload:**

```bash
npm run dev
```

**Production mode:**

```bash
npm run build
npm start
```

The service will be available at `http://localhost:8080`

## API Documentation

### POST /chat

Send a message to the DANI agent.

**Request Body:**

```json
{
  "message": "List all devices in the northeast region",
  "conversationId": "optional-conversation-id",
  "complexity": "SIMPLE|PROCEDURAL|ANALYTICAL"
}
```

**Fields:**

- `message` (required): The user's message/query
- `conversationId` (optional): ID for multi-turn conversations. If not provided, a new conversation is created
- `complexity` (optional): Query complexity level. If not specified, auto-detected from query
  - `SIMPLE`: Uses Claude Haiku 4.5 for quick, simple queries (10x cheaper)
  - `PROCEDURAL`: Uses Claude Sonnet 4.5 for multi-step tasks
  - `ANALYTICAL`: Uses Claude Sonnet 4.5 with extended thinking (10k token budget) for complex analysis

**Response:**

```json
{
  "response": "DANI's response text",
  "conversationId": "uuid-v4-conversation-id",
  "model": "claude-sonnet-4-5-20250929",
  "usage": {
    "input_tokens": 1250,
    "output_tokens": 420,
    "cache_creation_tokens": 850,
    "cache_read_tokens": 2100
  }
}
```

**With Extended Cache TTL (Beta):**

When `CACHE_TTL` is configured, responses include cache token breakdown by duration:

```json
{
  "usage": {
    "input_tokens": 1250,
    "output_tokens": 420,
    "cache_creation_tokens": 850,
    "cache_read_tokens": 2100,
    "cache_creation_5m_tokens": 850,
    "cache_creation_1h_tokens": 0,
    "cache_read_5m_tokens": 2100,
    "cache_read_1h_tokens": 0
  }
}
```

See [Cache Configuration](#cache-configuration) for details on enabling this feature.

**Error Response:**

```json
{
  "error": "Error Type",
  "message": "Detailed error message",
  "conversationId": "conversation-id-if-available"
}
```

### GET /health

Health check endpoint for monitoring and load balancers.

**Response:**

```json
{
  "status": "healthy|degraded|unhealthy",
  "mcp_servers": {
    "drm": "connected|disconnected|error",
    "outage": "connected|disconnected|error"
  },
  "uptime": 3600.5,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Status Levels:**
- `healthy`: All systems operational, MCP servers connected
- `degraded`: Some MCP servers unavailable but agent functional
- `unhealthy`: Critical failures, service should not receive traffic

## Usage Examples

### Simple Query (Fast & Cheap)

```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "List all devices",
    "complexity": "SIMPLE"
  }'
```

### Procedural Query with Conversation

```bash
# First message
RESPONSE=$(curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the status of device XYZ-123?",
    "complexity": "PROCEDURAL"
  }')

# Extract conversationId from response
CONV_ID=$(echo $RESPONSE | jq -r '.conversationId')

# Follow-up message in same conversation
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"What about device XYZ-124?\",
    \"conversationId\": \"$CONV_ID\",
    \"complexity\": \"PROCEDURAL\"
  }"
```

### Analytical Query with Extended Thinking

```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze connectivity issues in the northeast region over the past 7 days, identify patterns, root causes, and provide recommendations",
    "complexity": "ANALYTICAL"
  }'
```

### Health Check

```bash
curl http://localhost:8080/health
```

## Docker Deployment

### Build Docker Image

```bash
docker build -t dani-agent:latest .
```

### Run with Docker

```bash
docker run -d \
  --name dani-agent \
  --network dani_network \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-your-key \
  -e DRM_MCP_URL=http://drm-mcp-server:3001/mcp \
  -e OUTAGE_MCP_URL=http://outage-monitor-mcp:3002/mcp \
  dani-agent:latest
```

### Run with Docker Compose

From the root of the DANI project:

```bash
docker-compose up -d dani-agent
```

View logs:

```bash
docker-compose logs -f dani-agent
```

Stop the service:

```bash
docker-compose down
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Anthropic API key (or AWS Secrets Manager ARN) |
| `DRM_MCP_URL` | No | `http://drm-mcp-server:3001/mcp` | DRM MCP server URL |
| `OUTAGE_MCP_URL` | No | `http://outage-monitor-mcp:3002/mcp` | Outage Monitor MCP server URL |
| `PORT` | No | `8080` | HTTP server port |
| `NODE_ENV` | No | `production` | Node environment |
| `LOG_LEVEL` | No | `info` | Logging level (debug, info, warn, error) |
| `CACHE_TTL` | No | - | Cache duration: `5m` or `1h` (see [Cache Configuration](#cache-configuration)) |
| `SYSTEM_MESSAGE` | No | (from file) | System message for DANI personality |
| `MAX_CONVERSATION_HISTORY` | No | `20` | Max messages to keep in history |
| `CONVERSATION_TIMEOUT_MINUTES` | No | `60` | Minutes before conversation cleanup |
| `AWS_REGION` | No | `us-east-1` | AWS region for Secrets Manager |

### AWS Secrets Manager Integration

For production deployments, the agent automatically loads secrets from AWS Secrets Manager:

**Supported secret formats:**

1. **Direct secret ARN** in environment variable:
   ```env
   ANTHROPIC_API_KEY=arn:aws:secretsmanager:us-east-1:123456789:secret:anthropic-api-key
   ```

2. **JSON secret** with multiple values:
   ```json
   {
     "ANTHROPIC_API_KEY": "sk-ant-...",
     "DRM_API_KEY_ID": "...",
     "DRM_API_KEY_SECRET": "..."
   }
   ```

The agent will automatically detect ARNs and fetch secrets on startup. See [../guides/PHASE-1-SECRETS-MANAGER-GUIDE.md](../guides/PHASE-1-SECRETS-MANAGER-GUIDE.md) for setup instructions.

### System Message

The system message defines DANI's personality and capabilities. You can configure it in two ways:

1. **Via environment variable**: Set `SYSTEM_MESSAGE` in your `.env` file
2. **Via file**: Edit [system-message.md](system-message.md) in the project root

If both are provided, the environment variable takes precedence.

### Model Configuration

The service automatically selects models based on complexity:

| Complexity | Model | Max Tokens | Extended Thinking | Best For |
|------------|-------|------------|-------------------|----------|
| `SIMPLE` | Claude Haiku 4.5 | 20,000 | No | Quick queries, simple lookups |
| `PROCEDURAL` | Claude Sonnet 4.5 | 20,000 | No | Multi-step tasks, device management |
| `ANALYTICAL` | Claude Sonnet 4.5 | 20,000 | Yes (10k budget) | Complex analysis, troubleshooting |

## Prompt Caching

The service implements aggressive prompt caching to reduce costs:

- **System message** is cached (marked with `cache_control`)
- **Tools array** is cached (last tool marked with `cache_control`)
- **Cache hits** are logged in usage statistics

After the first request, you should see `cache_read_tokens > 0` in subsequent responses.

### Cost Savings Example

Without caching:
- Input: 5,000 tokens × $3/M = $0.015
- Output: 500 tokens × $15/M = $0.0075
- **Total: $0.0225 per request**

With caching (after first request):
- Input: 1,000 tokens × $3/M = $0.003
- Cached: 4,000 tokens × $0.30/M = $0.0012
- Output: 500 tokens × $15/M = $0.0075
- **Total: $0.0117 per request (48% savings)**

### Cache Configuration

#### Extended Cache TTL (Beta)

By default, prompt caching uses 5-minute cache duration. Anthropic offers an extended 1-hour cache duration through the `extended-cache-ttl-2025-04-11` beta feature.

**To enable extended cache tracking:**

1. Set the `CACHE_TTL` environment variable:
   ```bash
   CACHE_TTL=5m  # Default 5-minute cache
   # or
   CACHE_TTL=1h  # Extended 1-hour cache (2x write cost, same read cost)
   ```

2. When enabled, API responses include token breakdown by duration:
   ```json
   {
     "cache_creation_5m_tokens": 850,
     "cache_creation_1h_tokens": 0,
     "cache_read_5m_tokens": 2100,
     "cache_read_1h_tokens": 0
   }
   ```

**Pricing:**
- **5-minute cache write**: 1.25× base input token price
- **1-hour cache write**: 2× base input token price
- **Cache read** (both durations): 0.1× base input token price

**When to use 1-hour cache:**
- Prompts accessed more frequently than every 5 minutes
- Long system messages or tool schemas that rarely change
- High-volume production workloads with consistent prompts

## Structured Logging

The service uses structured JSON logging with Winston. All logs include:

- Timestamp
- Log level (info, warn, error, debug)
- Message
- Contextual metadata (conversationId, tool names, timing, etc.)
- Request correlation ID for distributed tracing

**Log Levels:**

- `error`: Errors and exceptions
- `warn`: Warnings (retries, MCP connection issues)
- `info`: Normal operation (requests, tool execution, cache stats)
- `debug`: Detailed debugging information

Set `LOG_LEVEL=debug` in `.env` for verbose logging.

**CloudWatch Integration:**

In production (AWS ECS), logs are automatically sent to CloudWatch Logs (`/ecs/dani-app`). Use pre-built CloudWatch Insights queries for analysis:

```
# Find slow requests
fields @timestamp, message, duration_ms
| filter service = "dani-agent" and duration_ms > 5000
| sort duration_ms desc

# Track cache performance
fields @timestamp, cache_read_tokens, cache_creation_tokens
| filter service = "dani-agent" and cache_read_tokens > 0
| stats avg(cache_read_tokens), sum(cache_read_tokens)
```

See [../cloudwatch-insights-queries.md](../cloudwatch-insights-queries.md) for more queries.

## Troubleshooting

### Service won't start

**Check Anthropic API key:**

```bash
# Verify key is set
echo $ANTHROPIC_API_KEY

# Test API key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
```

**Check logs:**

```bash
# Docker Compose
docker-compose logs -f dani-agent

# Docker
docker logs dani-agent

# Local
npm run dev  # Will show detailed logs
```

### MCP servers not connecting

**Check MCP server URLs:**

```bash
# Test DRM MCP server
curl http://drm-mcp-server:3001/mcp

# Test Outage Monitor MCP server
curl http://outage-monitor-mcp:3002/mcp
```

**Check Docker network:**

```bash
# List networks
docker network ls

# Inspect network
docker network inspect dani_network

# Ensure all containers are on same network
docker inspect dani-agent --format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

**The service will start even if MCP servers are unavailable**, but it will operate in degraded mode with no tools available.

### High API costs

**Enable caching:**
- Ensure system message is configured
- Check logs for `cache_read_tokens > 0` after first request
- Caching only works for identical system messages and tool arrays

**Use appropriate complexity:**
- Use `SIMPLE` for basic queries (Haiku is 10x cheaper)
- Only use `ANALYTICAL` when extended thinking is needed

**Monitor usage:**
- Check the `usage` field in API responses
- Set up CloudWatch alarms for high token usage

### Slow responses

**Check tool execution:**
- Tools that query external systems may be slow
- Check logs for tool execution duration
- Consider timeout configuration on MCP servers

**Check network:**
- Ensure low latency to Anthropic API
- Consider deploying in AWS us-east-1 (closest to Anthropic)

**Reduce conversation history:**
- Set `MAX_CONVERSATION_HISTORY` to lower value (e.g., 10)
- Fewer messages = faster API calls

## Project Structure

```
dani-agent/
├── src/
│   ├── index.ts              # Express server and main entry point
│   ├── agent.ts              # Core DANI agent logic and agentic loop
│   ├── mcp-client.ts         # MCP server connection and tool management
│   ├── anthropic-client.ts   # Claude API wrapper with caching
│   ├── bedrock-client.ts     # AWS Bedrock alternative (not active)
│   ├── query-analyzer.ts     # Query complexity detection
│   ├── config.ts             # Configuration and logging setup
│   ├── types.ts              # TypeScript type definitions
│   ├── ai-client.interface.ts # AIClient interface
│   └── shared/               # Shared utilities (logging, tracing, secrets)
│       ├── structured-logger.ts
│       ├── request-tracing-middleware.ts
│       ├── traced-http-client.ts
│       └── secrets-loader.ts
├── system-message.md         # DANI personality and instructions
├── Dockerfile                # Multi-stage production Dockerfile
├── docker-compose.yml        # Docker Compose configuration
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── .env.example              # Environment variable template
├── .gitignore                # Git ignore rules
└── README.md                 # This file
```

## Development

### Running Tests

```bash
# Run build to check for TypeScript errors
npm run build

# Watch mode for development
npm run watch
```

### Adding New MCP Servers

To add a new MCP server:

1. Add URL to `.env`:
   ```env
   NEW_MCP_URL=http://new-server:3000/mcp
   ```

2. Update [config.ts](src/config.ts) to parse the new server:
   ```typescript
   if (process.env.NEW_MCP_URL) {
     servers.push({
       name: 'new-server',
       url: process.env.NEW_MCP_URL,
     });
   }
   ```

The service will automatically discover and use tools from the new server.

### Modifying System Message

Edit [system-message.md](system-message.md) and restart the service. The new personality will be applied to all new conversations.

## Production Deployment

### AWS ECS Deployment

The DANI agent is deployed to AWS ECS Fargate as part of the main application. See [../DEPLOYMENT-GUIDE.md](../DEPLOYMENT-GUIDE.md) for complete instructions.

**Quick deployment:**

```bash
# From project root
./deploy.sh agent

# Or deploy all services
./deploy.sh
```

### Security Checklist

- [x] HTTPS in production (via ALB)
- [x] Secure API key storage (AWS Secrets Manager)
- [x] Enable rate limiting (via ALB)
- [x] Set up monitoring and alerts (CloudWatch)
- [x] Configure log aggregation (CloudWatch Logs)
- [x] Restrict network access to MCP servers (Security Groups)
- [x] Use read-only file system where possible
- [x] Keep dependencies updated
- [x] Non-root user in container

### Monitoring

**Key metrics to monitor:**

- Request latency (p50, p95, p99)
- Error rate
- MCP server connection status
- Cache hit rate
- Token usage per hour/day
- Active conversation count
- Memory usage

**Health check:**

Configure your load balancer or orchestrator to use `GET /health` for health checks.

**CloudWatch Alarms:**

- Health check failures
- High error rates (> 5%)
- High latency (p99 > 10s)
- Memory usage > 80%
- High token usage

### Scaling

The service is stateless except for in-memory conversation history. To scale:

1. **Horizontal scaling**: Run multiple instances behind a load balancer
2. **Session affinity**: Use sticky sessions to route conversations to same instance
3. **External state**: Consider Redis for conversation storage if needed
4. **Auto-scaling**: Configure ECS auto-scaling based on CPU/memory metrics

## Related Documentation

- [Main README](../README.md) - DANI platform overview
- [AWS Infrastructure](../AWS-INFRASTRUCTURE.md) - AWS resource specifications
- [Deployment Guide](../DEPLOYMENT-GUIDE.md) - Deployment workflows
- [Environment Variables](../ENV-VARIABLES.md) - Complete variable reference
- [Secrets Manager Guide](../guides/PHASE-1-SECRETS-MANAGER-GUIDE.md) - AWS Secrets setup
- [Logging Guide](../guides/PHASE-2-LOGGING-GUIDE.md) - Structured logging implementation
- [CloudWatch Queries](../cloudwatch-insights-queries.md) - Pre-built log queries

## Support

For issues and questions:
- Check the [troubleshooting section](#troubleshooting) above
- Review logs for detailed error messages
- Verify MCP server connectivity
- Test with simple queries first
- See [../README.md](../README.md) for support contacts

## Version History

**v1.0.0** - Production release
- Claude AI integration with Haiku 4.5 and Sonnet 4.5
- MCP server support (DRM and Outage Monitor)
- Prompt caching (5m and 1h TTL)
- Multi-turn conversations with auto-cleanup
- Query complexity analysis
- Extended thinking mode
- Docker deployment
- AWS Secrets Manager integration
- Structured logging with CloudWatch
- Production-ready error handling and retries

## License

Copyright (c) 2025 Flinn Technologies. All rights reserved.

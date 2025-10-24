# DANI Agent Service

Production-ready AI Agent service using Claude and the Model Context Protocol (MCP). This service provides a simple HTTP API for n8n workflows to interact with Claude AI, with support for tool execution via MCP servers.

## Features

- **Claude AI Integration**: Uses official Anthropic SDK with support for Claude Haiku and Sonnet models
- **Model Context Protocol**: Connects to MCP servers for dynamic tool discovery and execution
- **Prompt Caching**: Automatic caching of system messages and tools to reduce API costs
- **Multi-turn Conversations**: Stateful conversation management with automatic history trimming
- **Agentic Tool Loop**: Automatically handles multi-step tool execution
- **Model Selection**: Automatic model selection based on query complexity
- **Extended Thinking**: Support for Claude's thinking mode for analytical queries
- **Production Ready**: Docker containerization, health checks, graceful shutdown, structured logging
- **Retry Logic**: Exponential backoff for API failures and rate limits

## Architecture

```
HTTP API (Express)
    ↓
DANI Agent Core
    ↓
Claude API (with prompt caching)
    ↓
MCP Servers (DRM, Outage Monitor)
```

## Quick Start

### Prerequisites

- Node.js 20+
- Anthropic API key
- Access to MCP servers (DRM and Outage Monitor)

### Installation

1. Clone the repository and navigate to the project:

```bash
cd dani-agent
```

2. Install dependencies:

```bash
npm install
```

3. Create `.env` file from example:

```bash
cp .env.example .env
```

4. Edit `.env` and add your Anthropic API key:

```env
ANTHROPIC_API_KEY=sk-ant-your-api-key-here
DRM_MCP_URL=http://drm-mcp-server:3000/mcp
OUTAGE_MCP_URL=http://outage-monitor-mcp:3002/mcp
```

5. (Optional) Customize the system message in `system-message.md`

### Running Locally

**Development mode with auto-reload:**

```bash
npm run dev
```

**Build and run production:**

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
- `complexity` (optional): Query complexity level. Defaults to `ANALYTICAL` if not specified
  - `SIMPLE`: Uses Claude Haiku for quick, simple queries
  - `PROCEDURAL`: Uses Claude Sonnet for multi-step tasks
  - `ANALYTICAL`: Uses Claude Sonnet with extended thinking for complex analysis

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

Health check endpoint for monitoring.

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

## Usage Examples

### Simple Query

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
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the status of device XYZ-123?",
    "complexity": "PROCEDURAL"
  }'

# Response includes conversationId: "abc-123-def-456"

# Follow-up message in same conversation
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What about device XYZ-124?",
    "conversationId": "abc-123-def-456",
    "complexity": "PROCEDURAL"
  }'
```

### Analytical Query with Extended Thinking

```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze connectivity issues in the northeast region over the past 7 days and identify patterns",
    "complexity": "ANALYTICAL"
  }'
```

### Health Check

```bash
curl http://localhost:8080/health
```

### Using from n8n

In n8n, add an **HTTP Request** node with:

- **Method**: POST
- **URL**: `http://dani-agent:8080/chat`
- **Authentication**: None
- **Body Content Type**: JSON
- **Specify Body**: Using Fields
- **Fields**:
  - `message`: `{{ $json.userQuery }}`
  - `complexity`: `ANALYTICAL`
  - `conversationId`: `{{ $json.conversationId }}` (optional)

## Docker Deployment

### Build Docker Image

```bash
docker build -t dani-agent:latest .
```

### Run with Docker

```bash
docker run -d \
  --name dani-agent \
  --network root_default \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-your-key \
  -e DRM_MCP_URL=http://drm-mcp-server:3000/mcp \
  -e OUTAGE_MCP_URL=http://outage-monitor-mcp:3002/mcp \
  dani-agent:latest
```

### Run with Docker Compose

The service is configured to connect to the `root_default` network where the MCP servers are running.

1. Create `.env` file with your configuration
2. Ensure the `root_default` network exists (or modify `docker-compose.yml` for your network)
3. Start the service:

```bash
docker-compose up -d
```

4. View logs:

```bash
docker-compose logs -f dani-agent
```

5. Stop the service:

```bash
docker-compose down
```

### Connecting to Different Network

If your MCP servers are on a different Docker network, modify `docker-compose.yml`:

```yaml
networks:
  your-network-name:
    external: true
```

And update the service to use that network:

```yaml
services:
  dani-agent:
    networks:
      - your-network-name
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Anthropic API key |
| `DRM_MCP_URL` | No | `http://drm-mcp-server:3000/mcp` | DRM MCP server URL |
| `OUTAGE_MCP_URL` | No | `http://outage-monitor-mcp:3002/mcp` | Outage Monitor MCP server URL |
| `PORT` | No | `8080` | HTTP server port |
| `NODE_ENV` | No | `production` | Node environment |
| `LOG_LEVEL` | No | `info` | Logging level (debug, info, warn, error) |
| `CACHE_TTL` | No | - | Cache duration: `5m` or `1h` (see [Cache Configuration](#cache-configuration)) |
| `SYSTEM_MESSAGE` | No | (from file) | System message for DANI personality |
| `MAX_CONVERSATION_HISTORY` | No | `20` | Max messages to keep in history |
| `CONVERSATION_TIMEOUT_MINUTES` | No | `60` | Minutes before conversation cleanup |

### System Message

The system message defines DANI's personality and capabilities. You can configure it in two ways:

1. **Via environment variable**: Set `SYSTEM_MESSAGE` in your `.env` file
2. **Via file**: Edit `system-message.md` in the project root

If both are provided, the environment variable takes precedence.

### Model Configuration

The service automatically selects models based on complexity:

| Complexity | Model | Max Tokens | Extended Thinking |
|------------|-------|------------|-------------------|
| `SIMPLE` | Claude Haiku 4.5 | 20,000 | No |
| `PROCEDURAL` | Claude Sonnet 4.5 | 20,000 | No |
| `ANALYTICAL` | Claude Sonnet 4.5 | 20,000 | Yes (10k budget) |

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

## Logging

The service uses structured JSON logging with Winston. All logs include:

- Timestamp
- Log level (info, warn, error, debug)
- Message
- Contextual metadata (conversationId, tool names, timing, etc.)

**Log Levels:**

- `error`: Errors and exceptions
- `warn`: Warnings (retries, MCP connection issues)
- `info`: Normal operation (requests, tool execution, cache stats)
- `debug`: Detailed debugging information

Set `LOG_LEVEL=debug` in `.env` for verbose logging.

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
curl http://drm-mcp-server:3000/mcp

# Test Outage Monitor MCP server
curl http://outage-monitor-mcp:3002/mcp
```

**Check Docker network:**

```bash
# List networks
docker network ls

# Inspect network
docker network inspect your-network-name

# Ensure all containers are on same network
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
- Set up alerts for high token usage

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
│   ├── config.ts             # Configuration and logging setup
│   └── types.ts              # TypeScript type definitions
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

2. Update `config.ts` to parse the new server:
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

Edit `system-message.md` and restart the service. The new personality will be applied to all new conversations.

## Production Deployment

### Security Checklist

- [ ] Use HTTPS in production (reverse proxy with SSL/TLS)
- [ ] Secure API key storage (secrets manager, not plain .env)
- [ ] Enable rate limiting (use nginx or API gateway)
- [ ] Set up monitoring and alerts
- [ ] Configure log aggregation (CloudWatch, DataDog, etc.)
- [ ] Restrict network access to MCP servers
- [ ] Use read-only file system where possible
- [ ] Keep dependencies updated

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

### Scaling

The service is stateless except for in-memory conversation history. To scale:

1. **Horizontal scaling**: Run multiple instances behind a load balancer
2. **Session affinity**: Use sticky sessions to route conversations to same instance
3. **External state**: Consider Redis for conversation storage if needed

## License

MIT

## Support

For issues and questions:
- Check the troubleshooting section above
- Review logs for detailed error messages
- Verify MCP server connectivity
- Test with simple queries first

## Version History

**v1.0.0** - Initial release
- Claude AI integration with Haiku and Sonnet models
- MCP server support (DRM and Outage Monitor)
- Prompt caching
- Multi-turn conversations
- Docker deployment
- Production-ready logging and error handling

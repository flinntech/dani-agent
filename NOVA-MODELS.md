# Amazon Nova Models Configuration

The DANI Agent has been configured to use **Amazon Nova models** through AWS Bedrock:

## Current Model Configuration

| Complexity Level | Model | Use Case |
|-----------------|-------|----------|
| **SIMPLE** | `amazon.nova-micro-v1:0` | Fast queries, status checks, simple lookups |
| **PROCEDURAL** | `amazon.nova-lite-v1:0` | Multi-step tasks, comparisons, filtering |
| **ANALYTICAL** | `amazon.nova-pro-v1:0` | Complex analysis, reasoning, diagnostics |

## Benefits of Amazon Nova Models

- **Lower cost** - Significantly cheaper than Claude models
- **Faster responses** - Especially Nova Micro for simple queries
- **Multimodal support** - Nova Lite and Pro support images and video
- **Native AWS integration** - No third-party API dependencies
- **AWS billing consolidation** - All costs go through AWS account

## Current Configuration

The agent is configured to use **IAM roles** for authentication:

```bash
# .env configuration
USE_BEDROCK=true
AWS_REGION=us-east-1
# No explicit credentials needed - uses IAM role
```

## Deployment Requirements

### ✅ For AWS Infrastructure (EC2, ECS, EKS, Lambda)

**No additional configuration needed!** The agent will automatically use the IAM role attached to your infrastructure.

**Required IAM Permissions:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/amazon.nova-*"
      ]
    }
  ]
}
```

**Enable Model Access:**
1. Go to AWS Console → Bedrock → Model Access
2. Enable the following models:
   - Amazon Nova Micro
   - Amazon Nova Lite
   - Amazon Nova Pro
3. Wait for approval (usually instant)

### ⚠️ For Local Development

If you need to test locally (laptop, WSL, etc.), you must provide AWS credentials:

```bash
# .env - add these lines
AWS_ACCESS_KEY_ID=AKIA...your-key...
AWS_SECRET_ACCESS_KEY=your-secret-key...
```

Then restart the service:
```bash
cd /home/flinn/projects/dani
docker-compose restart dani-agent
```

## Switching Models

To change which models are used for each complexity level, edit [src/config.ts](src/config.ts):

```typescript
export const MODEL_CONFIG = {
  SIMPLE: {
    model: 'amazon.nova-micro-v1:0',  // Change this
    max_tokens: 20000,
    thinking: { type: 'disabled' as const },
  },
  PROCEDURAL: {
    model: 'amazon.nova-lite-v1:0',   // Change this
    max_tokens: 20000,
    thinking: { type: 'disabled' as const },
  },
  ANALYTICAL: {
    model: 'amazon.nova-pro-v1:0',    // Change this
    max_tokens: 20000,
    thinking: { type: 'enabled' as const, budget_tokens: 10000 },
  },
} as const;
```

Available Nova models:
- `amazon.nova-micro-v1:0` - Fastest, lowest cost, text-only
- `amazon.nova-lite-v1:0` - Fast, very low cost, multimodal
- `amazon.nova-pro-v1:0` - Advanced reasoning, multimodal

After making changes:
```bash
cd /home/flinn/projects/dani/dani-agent
npm run build
cd /home/flinn/projects/dani
docker-compose build dani-agent
docker-compose up -d dani-agent
```

## Switching Back to Claude Models

If you want to switch back to Claude models:

1. Edit [src/config.ts](src/config.ts):
```typescript
export const MODEL_CONFIG = {
  SIMPLE: {
    model: 'claude-haiku-4-5-20251001',
    // ...
  },
  PROCEDURAL: {
    model: 'claude-sonnet-4-5-20250929',
    // ...
  },
  ANALYTICAL: {
    model: 'claude-sonnet-4-5-20250929',
    // ...
  },
} as const;
```

2. Rebuild and restart:
```bash
cd /home/flinn/projects/dani/dani-agent
npm run build
cd /home/flinn/projects/dani
docker-compose build dani-agent
docker-compose up -d dani-agent
```

## Automatic Complexity Detection

The agent automatically detects query complexity using **Nova Micro** (configured in [src/query-analyzer.ts](src/query-analyzer.ts)). This ensures fast, low-cost classification before routing to the appropriate model.

## Monitoring

To see which model is being used for each request, check the logs:

```bash
docker-compose logs -f dani-agent | grep -i "sending message"
```

You should see logs like:
```
Sending message to Claude via Bedrock {"model":"amazon.nova-micro-v1:0",...}
```

## Cost Comparison

Approximate costs (as of Dec 2024):

| Model | Input Tokens (per 1M) | Output Tokens (per 1M) |
|-------|----------------------|----------------------|
| Nova Micro | $0.035 | $0.14 |
| Nova Lite | $0.06 | $0.24 |
| Nova Pro | $0.80 | $3.20 |
| Claude Haiku | $0.80 | $4.00 |
| Claude Sonnet | $3.00 | $15.00 |

**Nova Micro is ~23x cheaper than Claude Haiku for simple queries!**

## Troubleshooting

### Error: "Could not load credentials from any providers"

This is expected when running locally without explicit AWS credentials.

**Solutions:**
- Add `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to `.env` (for local testing)
- Deploy to AWS infrastructure where IAM roles work automatically (for production)

### Error: "Access denied" or "Forbidden"

**Solutions:**
1. Verify model access is enabled in Bedrock console
2. Check IAM role/user has `bedrock:InvokeModel` permission
3. Verify the region (us-east-1) supports Nova models

### Error: "Model not found"

**Solutions:**
1. Enable Nova models in AWS Bedrock console (Model Access page)
2. Wait a few minutes for model access to propagate
3. Verify you're using the correct model IDs

### Empty Responses (Fixed)

**Symptom:** Token usage shows successful API calls but no text displayed.

**Root Cause:** Nova models return content blocks with structure `[{ text: "..." }]` without the `type` field, whereas Claude models return `[{ type: "text", text: "..." }]`. The `extractTextContent()` method was filtering for blocks with `type === 'text'`, which Nova blocks don't have.

**Solution:** Updated [src/bedrock-client.ts](src/bedrock-client.ts) to normalize Nova content blocks to Anthropic format in the `convertToAnthropicMessage()` method:

```typescript
// Nova content blocks have structure: [{ text: "..." }] without type field
// Convert to Anthropic format: [{ type: "text", text: "..." }]
const normalizedContent = (outputMessage.content || []).map((block: any) => {
  if (block.text !== undefined) {
    return {
      type: 'text',
      text: block.text,
    };
  } else if (block.toolUse) {
    // Nova tool use format
    return {
      type: 'tool_use',
      id: block.toolUse.toolUseId,
      name: block.toolUse.name,
      input: block.toolUse.input,
    };
  }
  return block;
});
```

This fix was applied on 2025-10-27 and resolves the empty response issue.

## Support

For issues:
1. Check logs: `docker-compose logs dani-agent`
2. Verify configuration: `grep USE_BEDROCK /home/flinn/projects/dani/dani-agent/.env`
3. Test connectivity: `curl http://localhost:8080/health`
4. Review [BEDROCK-MIGRATION.md](BEDROCK-MIGRATION.md) for detailed setup

## Summary

✅ **What's Working:**
- Code is configured to use Amazon Nova models
- IAM role authentication is set up
- Agent builds and starts successfully
- Content block normalization fixed (empty response issue resolved)
- Tool use support for Nova models
- Ready for AWS deployment

⏳ **What's Pending:**
- Deploy to AWS infrastructure (EC2/ECS/EKS) for IAM role to work
- Or provide AWS credentials for local testing

The agent will work perfectly once deployed to AWS infrastructure with the proper IAM role attached!

## Recent Fixes

### 2025-10-27: Empty Response Fix
Fixed issue where Nova API calls succeeded (showing token usage) but returned empty text content to users. The problem was that Nova's content blocks don't include the `type` field that Claude's blocks have. Updated `convertToAnthropicMessage()` to normalize Nova content blocks to Anthropic format before returning.

# AWS Bedrock Migration Guide

This guide explains how to migrate the DANI Agent from using Anthropic's API directly to using AWS Bedrock.

## Overview

The DANI Agent now supports **two AI providers**:
1. **Anthropic Direct API** - Direct integration with Anthropic's Claude API
2. **AWS Bedrock** - Claude models through AWS Bedrock service

Both providers support the same features:
- Multiple Claude models (Haiku, Sonnet)
- Tool use / function calling
- Automatic complexity detection
- Extended thinking mode (analytical queries)
- Token usage tracking

## What Changed

### Code Changes
- Added `BedrockClient` class ([src/bedrock-client.ts](src/bedrock-client.ts))
- Created `AIClient` interface for unified client abstraction
- Updated `AnthropicClient` and `BedrockClient` to implement `AIClient`
- Modified `QueryAnalyzer` to support both providers
- Updated configuration to support AWS credentials
- Modified `index.ts` to initialize the appropriate client based on config

### Configuration Changes
- New environment variables:
  - `USE_BEDROCK` - Set to `true` to use Bedrock
  - `AWS_REGION` - AWS region (e.g., `us-east-1`)
  - `AWS_ACCESS_KEY_ID` - Optional if using IAM role
  - `AWS_SECRET_ACCESS_KEY` - Optional if using IAM role

## Migration Steps

### Option 1: Switch to Bedrock

1. **Update `.env` file:**

```bash
# Comment out Anthropic configuration
# USE_ANTHROPIC=true
# ANTHROPIC_API_KEY=sk-ant-...

# Enable Bedrock
USE_BEDROCK=true
AWS_REGION=us-east-1

# Optional: Add AWS credentials (not needed if using IAM role)
# AWS_ACCESS_KEY_ID=your-access-key-id
# AWS_SECRET_ACCESS_KEY=your-secret-access-key
```

2. **Enable Claude Models in AWS Bedrock:**

Go to the AWS Bedrock console and enable model access for:
- Claude 3.5 Haiku (latest)
- Claude 3.5 Sonnet (latest)
- Claude Haiku 4.5 (latest)
- Claude Sonnet 4.5 (latest)

3. **Set up AWS Credentials (if not using IAM role):**

You can provide credentials in three ways:

**A. Environment Variables (recommended for Docker):**
```bash
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
```

**B. AWS Credentials File:**
```bash
# ~/.aws/credentials
[default]
aws_access_key_id = your-key
aws_secret_access_key = your-secret
```

**C. IAM Role (recommended for EC2/ECS):**
- Attach an IAM role to your EC2/ECS instance
- Grant the role `bedrock:InvokeModel` permission
- No credentials needed in the code

4. **Restart the service:**

```bash
cd /home/flinn/projects/dani/dani-agent
npm run build
npm start
```

Or with Docker:

```bash
cd /home/flinn/projects/dani
docker-compose restart dani-agent
```

### Option 2: Keep Using Anthropic Direct API

No changes needed! Just keep your existing configuration:

```bash
USE_ANTHROPIC=true
ANTHROPIC_API_KEY=sk-ant-...
```

## AWS IAM Permissions

If using IAM roles, attach this policy to your role:

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
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
      ]
    }
  ]
}
```

## Model Mapping

The agent automatically maps internal model names to Bedrock model IDs:

| Internal Model | Bedrock Model ID |
|---|---|
| `claude-haiku-4-5-20251001` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `claude-sonnet-4-5-20250929` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `claude-3-5-sonnet-20241022` | `us.anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `claude-3-5-haiku-20241022` | `us.anthropic.claude-3-5-haiku-20241022-v1:0` |

## Feature Comparison

| Feature | Anthropic Direct | AWS Bedrock |
|---------|-----------------|-------------|
| Tool Use / Function Calling | ✅ | ✅ |
| Extended Thinking Mode | ✅ | ✅ |
| Prompt Caching | ✅ (5m, 1h) | ❌ (not yet supported) |
| Token Usage Tracking | ✅ | ✅ |
| Cache Token Breakdown | ✅ | ❌ |
| Automatic Complexity Detection | ✅ | ✅ |
| Multi-turn Agentic Loop | ✅ | ✅ |

**Note:** AWS Bedrock does not currently support prompt caching for Claude models. This means:
- `CACHE_TTL` setting is ignored when using Bedrock
- All cache-related token counts will be 0
- Slightly higher token costs compared to Anthropic Direct with caching

## Testing

After migration, test the agent with a simple query:

```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, are you using Bedrock?"}'
```

Check the logs to verify:

```bash
# Docker
docker-compose logs dani-agent | grep -i bedrock

# Local
tail -f /var/log/dani-agent/combined.log | grep -i bedrock
```

You should see:
```
Initializing AWS Bedrock client
Sending message to Claude via Bedrock
```

## Troubleshooting

### Error: "Missing required environment variables for Bedrock: AWS_REGION"

Solution: Set `AWS_REGION` in your `.env` file:
```bash
AWS_REGION=us-east-1
```

### Error: "Could not resolve endpoint"

Solutions:
1. Verify the region is correct and supports Bedrock
2. Check that Claude models are enabled in that region
3. Supported regions: `us-east-1`, `us-west-2`, `eu-west-1`, `ap-northeast-1`

### Error: "Access denied"

Solutions:
1. Verify AWS credentials are correct
2. Check IAM permissions include `bedrock:InvokeModel`
3. Verify model access is enabled in Bedrock console

### Error: "Throttling" or "Rate limit"

Solutions:
1. The agent automatically retries with exponential backoff
2. Check AWS Bedrock quotas in your region
3. Consider requesting a quota increase

## Rollback

To rollback to Anthropic Direct API:

1. Update `.env`:
```bash
USE_BEDROCK=false
# or
USE_ANTHROPIC=true
ANTHROPIC_API_KEY=sk-ant-...
```

2. Restart the service:
```bash
docker-compose restart dani-agent
```

## Cost Considerations

### Anthropic Direct API
- Lower cost per token (especially with prompt caching)
- Pay directly to Anthropic
- Prompt caching can reduce costs by 90% for repeated context

### AWS Bedrock
- Higher cost per token (no caching)
- Billed through AWS
- Easier to integrate with AWS infrastructure
- May offer volume discounts through AWS Enterprise Agreement

**Recommendation:** Use Anthropic Direct API for cost savings, use Bedrock for AWS integration and compliance requirements.

## Architecture

```
┌─────────────────┐
│   DANI Agent    │
│                 │
│  ┌───────────┐  │
│  │ AIClient  │◄─┼─── Interface
│  │ Interface │  │
│  └─────┬─────┘  │
│        │        │
│  ┌─────┴──────────┐
│  │                │
│  ▼                ▼
│ AnthropicClient  BedrockClient
│  │                │
└──┼────────────────┼─┘
   │                │
   ▼                ▼
Anthropic API    AWS Bedrock
```

## Support

For issues or questions:
1. Check the logs: `/var/log/dani-agent/combined.log`
2. Verify configuration: `.env` file
3. Test connectivity: `curl` health endpoint
4. Review AWS Bedrock console for model access

## Additional Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Claude on Bedrock](https://docs.anthropic.com/en/api/claude-on-amazon-bedrock)
- [Anthropic Direct API](https://docs.anthropic.com/en/api/getting-started)
- [Model Access in Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)

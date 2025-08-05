# Slack MCP Server Specification

This document outlines the design and implementation plan for a Slack MCP server that provides workspace integration capabilities through user and bot tokens.

The MCP server will support workspace configuration management, message retrieval with mention filtering, channel listing, message posting, and message history tracking. Users will authenticate using Slack bot tokens stored securely in the database.

The system will be built using Cloudflare Workers with Hono as the API framework, Drizzle ORM for database operations, and the Slack Web API for Slack integration.

## 1. Technology Stack

- **Edge Runtime:** Cloudflare Workers
- **API Framework:** Hono.js (TypeScript-based API framework)
- **Database:** Cloudflare D1 (serverless SQLite)
- **ORM:** Drizzle ORM for type-safe database operations
- **MCP Framework:** @modelcontextprotocol/sdk and @hono/mcp
- **Slack Integration:** @slack/web-api for Slack API interactions

## 2. Database Schema Design

The database will store workspace configurations and track all messages posted through the MCP server for audit and retrieval purposes.

### 2.1. workspaces Table

- id (TEXT, Primary Key, UUID)
- team_name (TEXT, NOT NULL) - Slack workspace name (from auth.test response)
- team_id (TEXT, NOT NULL, UNIQUE) - Slack team/workspace ID
- workspace_url (TEXT, NOT NULL) - Slack workspace URL (e.g., https://mycompany.slack.com/)
- bot_token (TEXT, NOT NULL) - Encrypted Slack bot token
- user_id (TEXT, NOT NULL) - Slack user ID of the person who configured this workspace
- bot_id (TEXT, NOT NULL) - Bot ID from Slack
- description (TEXT, NULLABLE) - Optional user-provided description for the workspace
- created_at (INTEGER, NOT NULL) - Unix timestamp
- updated_at (INTEGER, NOT NULL) - Unix timestamp
- is_active (INTEGER, NOT NULL, DEFAULT 1) - Boolean flag for active workspaces

### 2.2. posted_messages Table

- id (TEXT, Primary Key, UUID)
- workspace_id (TEXT, NOT NULL, Foreign Key to workspaces.id)
- channel_id (TEXT, NOT NULL) - Slack channel ID where message was posted
- channel_name (TEXT, NOT NULL) - Human-readable channel name
- message_ts (TEXT, NOT NULL) - Slack message timestamp
- message_text (TEXT, NOT NULL) - The actual message content posted
- posted_at (INTEGER, NOT NULL) - Unix timestamp when posted via MCP
- posted_by (TEXT, NULLABLE) - Identifier of who posted via MCP (if available)

## 3. MCP Server Tools

The MCP server will expose the following tools for Slack workspace interaction:

### 3.1. Workspace Management Tools

- **configure_workspace**
  - Description: Configure a new Slack workspace with automatic user identification
  - Parameters:
    - bot_token (string, required): Slack bot token (xoxb-...)
    - description (string, optional): Optional description for the workspace
  - Process:
    1. Validates the bot token by calling Slack's `auth.test` API
    2. Extracts workspace info from the auth response:
       - `team_name` (e.g., "MyCompany")
       - `team_id` (e.g., "T1234567890")
       - `workspace_url` (e.g., "https://mycompany.slack.com/")
       - `user_id` (e.g., "U0987654321")
       - `bot_id` (e.g., "B1122334455")
    3. Stores workspace configuration associated with that user
    4. Returns workspace configuration details

- **list_workspaces**
  - Description: Get all configured Slack workspaces for the authenticated user
  - Parameters: 
    - user_context (string, required): User identification context from MCP client
  - Returns only workspaces configured by the requesting user

### 3.2. Message Retrieval Tools

- **get_mentions**
  - Description: Get messages mentioning the workspace owner (registered user) within a time range
  - Parameters:
    - workspace_id (string, required): Target workspace ID
    - days_back (number, optional, default: 1): How many days back to search (1, 7, 30, etc.)
    - limit (number, optional, default: 5): Maximum number of messages to return
  - Returns messages where the workspace owner (user_id from workspace config) is mentioned
  - Note: Searches for mentions of the user who configured the workspace, not arbitrary users

### 3.3. Channel Management Tools

- **list_user_channels**
  - Description: Get list of channels the bot/user is part of
  - Parameters:
    - workspace_id (string, required): Target workspace ID
    - limit (number, optional, default: 50): Maximum number of channels to return
    - include_private (boolean, optional, default: false): Include private channels

### 3.4. Message Posting Tools

- **post_message**
  - Description: Post a message to a specific channel
  - Parameters:
    - workspace_id (string, required): Target workspace ID
    - channel_id (string, required): Target channel ID
    - message (string, required): Message content to post
    - thread_ts (string, optional): Thread timestamp if replying to thread

### 3.5. Message History Tools

- **get_posted_messages**
  - Description: Retrieve all messages posted through this MCP server
  - Parameters:
    - workspace_id (string, optional): Filter by workspace
    - channel_id (string, optional): Filter by channel
    - limit (number, optional, default: 50): Maximum messages to return
    - offset (number, optional, default: 0): Pagination offset

## 4. API Endpoints

### 4.1. MCP Endpoint

- **ALL /mcp**
  - Description: Main MCP server endpoint handling JSON-RPC requests
  - Handles all MCP tool calls and server communication

### 4.2. Health Check Endpoint

- **GET /health**
  - Description: Simple health check endpoint
  - Returns server status and database connectivity

## 5. Integrations

- **Slack Web API**: For all Slack workspace interactions including message retrieval, channel listing, and message posting
- **Cloudflare D1**: For persistent storage of workspace configurations and message history
- **MCP SDK**: For implementing the Model Context Protocol server interface

## 6. Authentication Model

The MCP server uses Slack bot tokens with automatic user identification:

### How it works:
1. User creates a Slack app in their workspace and gets the bot token (`xoxb-...`)
2. When configuring a workspace, the MCP server automatically:
   - Uses the bot token to call Slack's `auth.test` API
   - Extracts workspace details from the response:
     - `team_name`: Workspace name (e.g., "MyCompany")
     - `team_id`: Unique workspace identifier
     - `workspace_url`: Workspace URL (e.g., "https://mycompany.slack.com/")
     - `user_id`: ID of the user who installed the bot
     - `bot_id`: Bot identifier
   - Associates the workspace with that specific user
3. All subsequent operations are filtered by the authenticated user

### User Identification Flow:
```
User provides bot token → Call auth.test API → Extract workspace & user info → Store workspace config
```

### Example auth.test Response:
```json
{
    "ok": true,
    "url": "https://mycompany.slack.com/",
    "team": "MyCompany",
    "user": "bot_user",
    "team_id": "T1234567890",
    "user_id": "U0987654321",
    "bot_id": "B1122334455",
    "is_enterprise_install": false
}
```

This ensures that:
- Users only see their own workspaces when listing
- Message operations are scoped to workspaces they configured
- No manual workspace name input required - uses actual Slack workspace name
- Workspace URL is stored for reference and potential future use
- Secure workspace isolation between different users

### Required Slack App Permissions

When creating the Slack app, the following Bot Token Scopes are required:

- `channels:read` - List public channels
- `groups:read` - List private channels user is in  
- `im:read` - List direct messages
- `mpim:read` - List group direct messages
- `chat:write` - Post messages to channels
- `users:read` - Read user information
- `search:read` - Search messages for mentions

## 7. Security Considerations

- Slack tokens will be encrypted before storage in the database
- User identification through `auth.test` API ensures workspace ownership
- Implement rate limiting for Slack API calls to respect Slack's rate limits
- Validate workspace ownership before allowing operations
- Sanitize and validate all user inputs, especially message content
- All workspace operations are scoped to the user who configured them

## 8. Token Setup Guide

Users will need to create a Slack app to obtain the bot token:

### Step 1: Create a Slack App
1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Give it a name (e.g., "MCP Slack Integration") and select your workspace
4. Click "Create App"

### Step 2: Set Required Permissions
In your app settings, go to "OAuth & Permissions" and add these Bot Token Scopes:
- `channels:read` - List public channels
- `groups:read` - List private channels user is in
- `im:read` - List direct messages
- `mpim:read` - List group direct messages
- `chat:write` - Post messages
- `users:read` - Read user information
- `search:read` - Search messages (for mentions)

### Step 3: Install App and Get Token
1. Click "Install to Workspace" 
2. Authorize the permissions
3. Copy the "Bot User OAuth Token" (starts with `xoxb-`)

That's the token you'll provide to the MCP server! The server will automatically identify you as the workspace owner.

## 9. Additional Notes

- The MCP server should handle Slack API rate limits gracefully with exponential backoff
- Message timestamps from Slack should be properly converted for database storage
- Consider implementing pagination for large result sets
- The server validates Slack tokens and extracts user info on workspace configuration
- Implement proper error handling for network failures and API errors
- User context from MCP client is used to filter workspace access

## 10. Further Reading

Take inspiration from the project template here: https://github.com/fiberplane/create-honc-app/tree/main/templates/d1

Slack Web API documentation: https://api.slack.com/web
MCP specification: https://spec.modelcontextprotocol.io/
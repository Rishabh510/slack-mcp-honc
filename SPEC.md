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
- user_id (TEXT, NOT NULL) - Human user's Slack ID (provided by user, not from auth.test)
- bot_id (TEXT, NOT NULL) - Bot's user ID from auth.test response (this is the bot's user ID)
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
  - Description: Configure a new Slack workspace with user identification
  - Parameters:
    - bot_token (string, required): Slack bot token (xoxb-...)
    - user_id (string, required): Your Slack user ID (get from: Click 3 dots > Copy member ID from your Slack profile)
    - description (string, optional): Optional description for the workspace
  - Process:
    1. Validates the bot token by calling Slack's `auth.test` API
    2. Extracts workspace info from the auth response:
       - `team_name` (e.g., "MyCompany")
       - `team_id` (e.g., "T1234567890")
       - `workspace_url` (e.g., "https://mycompany.slack.com/")
       - `bot_id` (e.g., "U0987654321") - This is the bot's user ID from auth.test
    3. Stores workspace configuration with encrypted bot token and provided user_id
    4. Returns unique workspace ID for future API calls

- **list_workspaces**
  - Description: Get all configured Slack workspaces (public listing)
  - Parameters: None
  - Returns: List of workspaces with team_name and description only (for privacy)
  - Note: Does not expose sensitive information like tokens or user IDs

### 3.2. Message Retrieval Tools

- **get_mentions**
  - Description: Get messages mentioning the user or channel notifications from a specific channel
  - Parameters:
    - workspace_id (string, required): Unique workspace ID from configure_workspace
    - channel_id (string, required): Channel ID to search for mentions
    - days_back (number, optional, default: 1): How many days back to search (1, 7, 30, etc.)
    - limit (number, optional, default: 5): Maximum number of messages to return
  - Process: 
    1. Uses Slack's conversations.history API to get messages from the specified channel
    2. Filters messages to find those containing:
       - `<@USER_ID>` - Direct user mentions
       - `<!channel>` - Channel-wide notifications (user gets notified for these too)
    3. Returns filtered messages with timestamps and links
  - Returns messages where the workspace user is mentioned or channel notifications occurred

### 3.3. Channel Management Tools

- **list_user_channels**
  - Description: Get list of channels the bot/user is part of
  - Parameters:
    - workspace_id (string, required): Unique workspace ID from configure_workspace
    - limit (number, optional, default: 10): Maximum number of channels to return
    - private_only (boolean, optional, default: false): Show only private channels

### 3.4. Message Posting Tools

- **post_message**
  - Description: Post a message to any specified channel in the workspace
  - Parameters:
    - workspace_id (string, required): Unique workspace ID from configure_workspace
    - channel_id (string, required): Target channel ID to post message to
    - message_text (string, required): Message content to post
  - Process:
    1. Validates workspace and channel access
    2. Posts the message to the specified channel
    3. Stores the posted message in the database for history
    4. Returns message details and Slack permalink
  - Returns message confirmation with link to posted message

### 3.5. Message History Tools

- **get_posted_messages**
  - Description: Get all messages posted through this MCP server
  - Parameters:
    - workspace_id (string, required): Unique workspace ID from configure_workspace
    - limit (number, optional, default: 50): Maximum number of messages to return

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
2. User provides their own Slack user ID (obtained from: Click 3 dots > Copy member ID from Slack profile)
3. When configuring a workspace, the MCP server:
   - Uses the bot token to call Slack's `auth.test` API
   - Extracts workspace details from the response:
     - `team_name`: Workspace name (e.g., "MyCompany")
     - `team_id`: Unique workspace identifier
     - `workspace_url`: Workspace URL (e.g., "https://mycompany.slack.com/")
     - `bot_id`: Bot's user ID (from auth.test - this is the bot's user ID)
   - Stores the provided human user_id separately for mention searches
   - Associates the workspace with the human user for secure access
4. All subsequent operations use the workspace ID for secure token lookup

### User Identification Flow:
```
User provides bot token + user_id → Call auth.test API → Extract workspace & bot info → Store workspace config with human user_id
```

### Example auth.test Response:
```json
{
    "ok": true,
    "url": "https://mycompany.slack.com/",
    "team": "MyCompany",
    "user": "bot_user",
    "team_id": "T1234567890",
    "user_id": "U0987654321",  // This is the BOT's user ID, not the human user
    "bot_id": "B1122334455",
    "is_enterprise_install": false
}
```

**Important Note**: The `user_id` from auth.test is the bot's user ID, not the human user's ID. That's why we require the human user to provide their own user_id separately.

This ensures that:
- Each workspace gets a unique ID for secure access
- Users provide their own user_id for accurate mention tracking
- Bot and human user identities are properly separated
- Public workspace listing shows only non-sensitive information
- Workspace URL and bot tokens remain private and encrypted
- Multiple users can safely use the same MCP server instance

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

### Step 4: Get Your User ID
1. In Slack, click on your profile picture or name
2. Click the 3 dots menu (More actions)
3. Select "Copy member ID"
4. This is your user_id (starts with `U`) - you'll need this when configuring the workspace

That's the bot token and user_id you'll provide to the MCP server! The server will automatically identify the workspace details.

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
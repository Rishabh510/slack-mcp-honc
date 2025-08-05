import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc, and } from "drizzle-orm";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  ENCRYPTION_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Simple encryption/decryption functions
async function encrypt(text: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const keyData = encoder.encode(key.slice(0, 32).padEnd(32, '0'));
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data
  );
  
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);
  
  return btoa(String.fromCharCode(...result));
}

async function decrypt(encryptedText: string, key: string): Promise<string> {
  const data = new Uint8Array(atob(encryptedText).split('').map(c => c.charCodeAt(0)));
  const keyData = new TextEncoder().encode(key.slice(0, 32).padEnd(32, '0'));
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encrypted
  );
  
  return new TextDecoder().decode(decrypted);
}

function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "slack-mcp-server",
    version: "1.0.0",
    description: "MCP server for Slack workspace integration with message posting and retrieval"
  });

  const db = drizzle(env.DB);

  // Configure workspace tool
  server.tool(
    "configure_workspace",
    {
      bot_token: z.string().min(1).describe("Slack bot token (xoxb-...)"),
      description: z.string().optional().describe("Optional description for the workspace")
    },
    async ({ bot_token, description }) => {
      try {
        // Validate token and get workspace info
        const slack = new WebClient(bot_token);
        const authResponse = await slack.auth.test();
        
        if (!authResponse.ok) {
          return {
            content: [{
              type: "text",
              text: "Invalid Slack bot token"
            }],
            isError: true
          };
        }

        const { team, team_id, url, user_id, bot_id } = authResponse;
        
        // Encrypt the bot token
        const encryptedToken = await encrypt(bot_token, env.ENCRYPTION_KEY);
        
        // Check if workspace already exists
        const existingWorkspace = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.teamId, team_id!))
          .get();

        let workspace;
        if (existingWorkspace) {
          // Update existing workspace
          [workspace] = await db.update(schema.workspaces)
            .set({
              teamName: team!,
              workspaceUrl: url!,
              botToken: encryptedToken,
              userId: user_id!,
              botId: bot_id!,
              description: description || null,
              updatedAt: new Date()
            })
            .where(eq(schema.workspaces.teamId, team_id!))
            .returning();
        } else {
          // Create new workspace
          [workspace] = await db.insert(schema.workspaces)
            .values({
              teamName: team!,
              teamId: team_id!,
              workspaceUrl: url!,
              botToken: encryptedToken,
              userId: user_id!,
              botId: bot_id!,
              description: description || null
            })
            .returning();
        }

        return {
          content: [{
            type: "text",
            text: `Workspace configured successfully:\n- Name: ${workspace.teamName}\n- ID: ${workspace.id}\n- URL: ${workspace.workspaceUrl}\n- Description: ${workspace.description || 'None'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error configuring workspace: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // List workspaces tool
  server.tool(
    "list_workspaces",
    {
      user_context: z.string().describe("User identification context")
    },
    async ({ user_context }) => {
      try {
        const workspaces = await db.select()
          .from(schema.workspaces)
          .where(and(
            eq(schema.workspaces.userId, user_context),
            eq(schema.workspaces.isActive, true)
          ));

        const workspaceList = workspaces.map(ws => ({
          id: ws.id,
          name: ws.teamName,
          url: ws.workspaceUrl,
          description: ws.description,
          created_at: ws.createdAt
        }));

        return {
          content: [{
            type: "text",
            text: `Found ${workspaces.length} workspace(s):\n${JSON.stringify(workspaceList, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing workspaces: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Get mentions tool
  server.tool(
    "get_mentions",
    {
      workspace_id: z.string().describe("Target workspace ID"),
      days_back: z.number().min(1).max(365).default(1).describe("How many days back to search"),
      limit: z.number().min(1).max(100).default(5).describe("Maximum number of messages to return")
    },
    async ({ workspace_id, days_back, limit }) => {
      try {
        // Get workspace and decrypt token
        const workspace = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .get();

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found"
            }],
            isError: true
          };
        }

        const botToken = await decrypt(workspace.botToken, env.ENCRYPTION_KEY);
        const slack = new WebClient(botToken);

        // Calculate timestamp for days_back
        const oldest = Math.floor((Date.now() - (days_back * 24 * 60 * 60 * 1000)) / 1000);

        // Search for mentions of the workspace owner
        const searchResult = await slack.search.messages({
          query: `<@${workspace.userId}>`,
          sort: 'timestamp',
          sort_dir: 'desc',
          count: limit
        });

        if (!searchResult.ok || !searchResult.messages?.matches) {
          return {
            content: [{
              type: "text",
              text: "No mentions found or search failed"
            }]
          };
        }

        const mentions = searchResult.messages.matches
          .filter(match => Number.parseFloat(match.ts!) >= oldest)
          .slice(0, limit)
          .map(match => ({
            channel: match.channel?.name,
            user: match.user,
            text: match.text,
            timestamp: match.ts,
            permalink: match.permalink
          }));

        return {
          content: [{
            type: "text",
            text: `Found ${mentions.length} mention(s) in the last ${days_back} day(s):\n${JSON.stringify(mentions, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error getting mentions: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // List user channels tool
  server.tool(
    "list_user_channels",
    {
      workspace_id: z.string().describe("Target workspace ID"),
      limit: z.number().min(1).max(1000).default(50).describe("Maximum number of channels to return"),
      include_private: z.boolean().default(false).describe("Include private channels")
    },
    async ({ workspace_id, limit, include_private }) => {
      try {
        const workspace = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .get();

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found"
            }],
            isError: true
          };
        }

        const botToken = await decrypt(workspace.botToken, env.ENCRYPTION_KEY);
        const slack = new WebClient(botToken);

        const channels = [];

        // Get public channels
        const publicChannels = await slack.conversations.list({
          types: 'public_channel',
          limit
        });

        if (publicChannels.ok && publicChannels.channels) {
          channels.push(...publicChannels.channels.map(ch => ({
            id: ch.id,
            name: ch.name,
            is_private: false,
            is_member: ch.is_member,
            purpose: ch.purpose?.value
          })));
        }

        // Get private channels if requested
        if (include_private) {
          const privateChannels = await slack.conversations.list({
            types: 'private_channel',
            limit
          });

          if (privateChannels.ok && privateChannels.channels) {
            channels.push(...privateChannels.channels.map(ch => ({
              id: ch.id,
              name: ch.name,
              is_private: true,
              is_member: ch.is_member,
              purpose: ch.purpose?.value
            })));
          }
        }

        return {
          content: [{
            type: "text",
            text: `Found ${channels.length} channel(s):\n${JSON.stringify(channels.slice(0, limit), null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing channels: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Post message tool
  server.tool(
    "post_message",
    {
      workspace_id: z.string().describe("Target workspace ID"),
      channel_id: z.string().describe("Target channel ID"),
      message_text: z.string().min(1).describe("Message content to post"),
      thread_ts: z.string().optional().describe("Thread timestamp if replying to thread")
    },
    async ({ workspace_id, channel_id, message_text, thread_ts }) => {
      try {
        const workspace = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .get();

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found"
            }],
            isError: true
          };
        }

        const botToken = await decrypt(workspace.botToken, env.ENCRYPTION_KEY);
        const slack = new WebClient(botToken);

        // Get channel info for name
        const channelInfo = await slack.conversations.info({
          channel: channel_id
        });

        const channelName = channelInfo.ok && channelInfo.channel ? 
          channelInfo.channel.name || channel_id : channel_id;

        // Post the message
        const result = await slack.chat.postMessage({
          channel: channel_id,
          text: message_text,
          thread_ts
        });

        if (!result.ok) {
          return {
            content: [{
              type: "text",
              text: `Failed to post message: ${result.error}`
            }],
            isError: true
          };
        }

        // Store the posted message in database
        const [postedMessage] = await db.insert(schema.postedMessages)
          .values({
            workspaceId: workspace_id,
            channelId: channel_id,
            channelName: channelName,
            messageText: message_text,
            messageTs: result.ts!,
            slackMessageId: (result.message as any)?.client_msg_id || null,
            userId: workspace.userId
          })
          .returning();

        return {
          content: [{
            type: "text",
            text: `Message posted successfully to #${channelName}:\n- Message ID: ${postedMessage.id}\n- Slack TS: ${result.ts}\n- Content: "${message_text}"`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error posting message: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  // Get posted messages tool
  server.tool(
    "get_posted_messages",
    {
      workspace_id: z.string().optional().describe("Filter by workspace ID"),
      channel_id: z.string().optional().describe("Filter by channel ID"),
      limit: z.number().min(1).max(1000).default(50).describe("Maximum messages to return"),
      offset: z.number().min(0).default(0).describe("Pagination offset")
    },
    async ({ workspace_id, channel_id, limit, offset }) => {
      try {
        const conditions = [];
        
        if (workspace_id) {
          conditions.push(eq(schema.postedMessages.workspaceId, workspace_id));
        }
        
        if (channel_id) {
          conditions.push(eq(schema.postedMessages.channelId, channel_id));
        }

        const query = db.select()
          .from(schema.postedMessages)
          .orderBy(desc(schema.postedMessages.createdAt))
          .limit(limit)
          .offset(offset);

        const messages = conditions.length > 0 
          ? await query.where(and(...conditions))
          : await query;

        const messageList = messages.map(msg => ({
          id: msg.id,
          workspace_id: msg.workspaceId,
          channel_id: msg.channelId,
          channel_name: msg.channelName,
          message_text: msg.messageText,
          message_ts: msg.messageTs,
          slack_message_id: msg.slackMessageId,
          user_id: msg.userId,
          created_at: msg.createdAt
        }));

        return {
          content: [{
            type: "text",
            text: `Found ${messages.length} posted message(s):\n${JSON.stringify(messageList, null, 2)}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error getting posted messages: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );

  return server;
}

app.get("/", (c) => {
  return c.text("Slack MCP Server");
});

app.get("/health", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    await db.select().from(schema.workspaces).limit(1);
    return c.json({ status: "healthy", database: "connected" });
  } catch (error) {
    return c.json({ 
      status: "unhealthy", 
      database: "disconnected",
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

app.all("/mcp", async (c) => {
  const mcpServer = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport();
  
  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

app.get("/openapi.json", c => {
  return c.json(createOpenAPISpec(app, {
    info: {
      title: "Slack MCP Server",
      version: "1.0.0",
      description: "MCP server for Slack workspace integration"
    },
  }));
});

app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));

export default app;
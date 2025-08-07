import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
};

interface SlackAuthTestResponse {
  ok: boolean;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id: string;
  is_enterprise_install?: boolean;
}

interface SlackMessage {
  type: string;
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  replies?: Array<{ user: string; ts: string }>;
}

interface SlackConversationsHistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  pin_count?: number;
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  created: number;
  is_archived: boolean;
  is_general: boolean;
  unlinked: number;
  name_normalized: string;
  is_shared: boolean;
  is_ext_shared: boolean;
  is_org_shared: boolean;
  pending_shared: string[];
  pending_connected_team_ids: string[];
  is_pending_ext_shared: boolean;
  is_member: boolean;
  is_open: boolean;
  topic: {
    value: string;
    creator: string;
    last_set: number;
  };
  purpose: {
    value: string;
    creator: string;
    last_set: number;
  };
  previous_names: string[];
  num_members: number;
}

interface SlackConversationsListResponse {
  ok: boolean;
  channels: SlackChannel[];
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackChatPostMessageResponse {
  ok: boolean;
  channel: string;
  ts: string;
  message: {
    type: string;
    subtype?: string;
    text: string;
    user: string;
    ts: string;
    bot_id?: string;
    app_id?: string;
  };
}

const app = new Hono<{ Bindings: Bindings }>();

function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "slack-mcp-server",
    version: "1.0.0",
    description: "MCP server for Slack workspace integration with message posting and retrieval capabilities"
  });

  const db = drizzle(env.DB);

  // Configure workspace tool
  server.tool(
    "configure_workspace",
    {
      bot_token: z.string().min(1).describe("Slack bot token (xoxb-...)"),
      user_id: z.string().min(1).describe("Your Slack user ID (get from: Click 3 dots > Copy member ID from your Slack profile)"),
      description: z.string().optional().describe("Optional description for the workspace")
    },
    async ({ bot_token, user_id, description }) => {
      try {
        const slack = new WebClient(bot_token);
        
        // Validate token and get workspace info
        const authResult = await slack.auth.test() as SlackAuthTestResponse;
        
        if (!authResult.ok) {
          return {
            content: [{
              type: "text",
              text: "Invalid bot token. Please check your token and try again."
            }],
            isError: true
          };
        }

        // Check if workspace already exists
        const existingWorkspace = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.teamId, authResult.team_id))
          .limit(1);

        if (existingWorkspace.length > 0) {
          // Update existing workspace
          const [updatedWorkspace] = await db.update(schema.workspaces)
            .set({
              teamName: authResult.team,
              workspaceUrl: authResult.url,
              botToken: bot_token, // In production, this should be encrypted
              userId: user_id,
              botId: authResult.user_id,
              description: description || null,
              updatedAt: new Date(),
              isActive: true
            })
            .where(eq(schema.workspaces.teamId, authResult.team_id))
            .returning();

          return {
            content: [{
              type: "text",
              text: `Workspace updated successfully!\n\nWorkspace ID: ${updatedWorkspace.id}\nTeam: ${updatedWorkspace.teamName}\nURL: ${updatedWorkspace.workspaceUrl}\nBot ID: ${updatedWorkspace.botId}`
            }]
          };
        }

        // Create new workspace
        const [newWorkspace] = await db.insert(schema.workspaces)
          .values({
            teamName: authResult.team,
            teamId: authResult.team_id,
            workspaceUrl: authResult.url,
            botToken: bot_token, // In production, this should be encrypted
            userId: user_id,
            botId: authResult.user_id,
            description: description || null
          })
          .returning();

        return {
          content: [{
            type: "text",
            text: `Workspace configured successfully!\n\nWorkspace ID: ${newWorkspace.id}\nTeam: ${newWorkspace.teamName}\nURL: ${newWorkspace.workspaceUrl}\nBot ID: ${newWorkspace.botId}\n\nYou can now use this workspace ID for other operations.`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error configuring workspace: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );

  // List workspaces tool
  server.tool(
    "list_workspaces",
    {},
    async () => {
      try {
        const workspaces = await db.select({
          id: schema.workspaces.id,
          teamName: schema.workspaces.teamName,
          description: schema.workspaces.description,
          isActive: schema.workspaces.isActive,
          createdAt: schema.workspaces.createdAt
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.isActive, true))
        .orderBy(desc(schema.workspaces.createdAt));

        if (workspaces.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No workspaces configured. Use configure_workspace to add a workspace."
            }]
          };
        }

        const workspaceList = workspaces.map(ws => 
          `• ${ws.teamName} (ID: ${ws.id})${ws.description ? ` - ${ws.description}` : ""}`
        ).join("\n");

        return {
          content: [{
            type: "text",
            text: `Configured Workspaces:\n\n${workspaceList}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing workspaces: ${error instanceof Error ? error.message : "Unknown error"}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      channel_id: z.string().min(1).describe("Channel ID to search for mentions"),
      days_back: z.number().min(1).max(365).default(1).describe("How many days back to search"),
      limit: z.number().min(1).max(100).default(5).describe("Maximum number of messages to return")
    },
    async ({ workspace_id, channel_id, days_back, limit }) => {
      try {
        // Get workspace
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found. Please check the workspace ID."
            }],
            isError: true
          };
        }

        const slack = new WebClient(workspace.botToken);
        
        // Calculate timestamp for days_back
        const oldest = Math.floor((Date.now() - (days_back * 24 * 60 * 60 * 1000)) / 1000);

        // Get messages from channel
        const result = await slack.conversations.history({
          channel: channel_id,
          oldest: oldest.toString(),
          limit: 100 // Get more messages to filter through
        }) as SlackConversationsHistoryResponse;

        if (!result.ok) {
          return {
            content: [{
              type: "text",
              text: "Failed to retrieve messages. Check if the bot has access to this channel."
            }],
            isError: true
          };
        }

        // Filter messages for mentions
        const mentionPattern = new RegExp(`<@${workspace.userId}>|<!channel>|<!here>`);
        const mentionedMessages = result.messages
          .filter(msg => msg.text && mentionPattern.test(msg.text))
          .slice(0, limit)
          .map(msg => ({
            text: msg.text,
            timestamp: msg.ts,
            user: msg.user,
            permalink: `${workspace.workspaceUrl}archives/${channel_id}/p${msg.ts.replace('.', '')}`
          }));

        if (mentionedMessages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No mentions found in the last ${days_back} day(s) in this channel.`
            }]
          };
        }

        const messageList = mentionedMessages.map(msg => 
          `• ${msg.text.substring(0, 100)}${msg.text.length > 100 ? '...' : ''}\n  User: ${msg.user || 'Unknown'} | Time: ${new Date(Number.parseFloat(msg.timestamp) * 1000).toLocaleString()}\n  Link: ${msg.permalink}`
        ).join('\n\n');

        return {
          content: [{
            type: "text",
            text: `Found ${mentionedMessages.length} mention(s) in the last ${days_back} day(s):\n\n${messageList}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error retrieving mentions: ${error instanceof Error ? error.message : "Unknown error"}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      limit: z.number().min(1).max(100).default(10).describe("Maximum number of channels to return"),
      private_only: z.boolean().default(false).describe("Show only private channels")
    },
    async ({ workspace_id, limit, private_only }) => {
      try {
        // Get workspace
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found. Please check the workspace ID."
            }],
            isError: true
          };
        }

        const slack = new WebClient(workspace.botToken);
        
        // Get channels
        const result = await slack.conversations.list({
          limit: limit,
          types: private_only ? 'private_channel' : 'public_channel,private_channel'
        }) as SlackConversationsListResponse;

        if (!result.ok) {
          return {
            content: [{
              type: "text",
              text: "Failed to retrieve channels."
            }],
            isError: true
          };
        }

        const channels = result.channels
          .filter(channel => private_only ? channel.is_private : true)
          .filter(channel => channel.is_member)
          .slice(0, limit);

        if (channels.length === 0) {
          return {
            content: [{
              type: "text",
              text: private_only ? "No private channels found that the bot is a member of." : "No channels found that the bot is a member of."
            }]
          };
        }

        const channelList = channels.map(channel => 
          `• #${channel.name} (${channel.id}) - ${channel.is_private ? 'Private' : 'Public'}${channel.topic?.value ? ` - ${channel.topic.value}` : ''}`
        ).join('\n');

        return {
          content: [{
            type: "text",
            text: `Channels (${channels.length}):\n\n${channelList}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error listing channels: ${error instanceof Error ? error.message : "Unknown error"}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      channel_id: z.string().min(1).describe("Target channel ID to post message to"),
      message_text: z.string().min(1).describe("Message content to post")
    },
    async ({ workspace_id, channel_id, message_text }) => {
      try {
        // Get workspace
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found. Please check the workspace ID."
            }],
            isError: true
          };
        }

        const slack = new WebClient(workspace.botToken);
        
        // Get channel info first
        const channelInfo = await slack.conversations.info({
          channel: channel_id
        });

        if (!channelInfo.ok || !channelInfo.channel) {
          return {
            content: [{
              type: "text",
              text: "Channel not found or bot doesn't have access to this channel."
            }],
            isError: true
          };
        }

        // Post message
        const result = await slack.chat.postMessage({
          channel: channel_id,
          text: message_text
        }) as SlackChatPostMessageResponse;

        if (!result.ok) {
          return {
            content: [{
              type: "text",
              text: "Failed to post message. Check if the bot has permission to post in this channel."
            }],
            isError: true
          };
        }

        // Store posted message in database
        const [postedMessage] = await db.insert(schema.postedMessages)
          .values({
            workspaceId: workspace_id,
            channelId: channel_id,
            channelName: (channelInfo.channel as SlackChannel).name || 'unknown',
            messageText: message_text,
            messageTs: result.ts,
            slackMessageId: result.message.ts,
            userId: workspace.userId
          })
          .returning();

        const permalink = `${workspace.workspaceUrl}archives/${channel_id}/p${result.ts.replace('.', '')}`;

        return {
          content: [{
            type: "text",
            text: `Message posted successfully!\n\nChannel: #${(channelInfo.channel as SlackChannel).name}\nMessage: ${message_text}\nTimestamp: ${result.ts}\nLink: ${permalink}\n\nMessage ID: ${postedMessage.id}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error posting message: ${error instanceof Error ? error.message : "Unknown error"}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      limit: z.number().min(1).max(100).default(50).describe("Maximum number of messages to return")
    },
    async ({ workspace_id, limit }) => {
      try {
        // Get workspace
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace_id))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found. Please check the workspace ID."
            }],
            isError: true
          };
        }

        // Get posted messages
        const messages = await db.select()
          .from(schema.postedMessages)
          .where(eq(schema.postedMessages.workspaceId, workspace_id))
          .orderBy(desc(schema.postedMessages.createdAt))
          .limit(limit);

        if (messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No messages have been posted through this MCP server for this workspace."
            }]
          };
        }

        const messageList = messages.map(msg => {
          const permalink = `${workspace.workspaceUrl}archives/${msg.channelId}/p${msg.messageTs.replace('.', '')}`;
          return `• #${msg.channelName}: ${msg.messageText.substring(0, 100)}${msg.messageText.length > 100 ? '...' : ''}\n  Posted: ${msg.createdAt.toLocaleString()}\n  Link: ${permalink}`;
        }).join('\n\n');

        return {
          content: [{
            type: "text",
            text: `Posted Messages (${messages.length}):\n\n${messageList}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error retrieving posted messages: ${error instanceof Error ? error.message : "Unknown error"}`
          }],
          isError: true
        };
      }
    }
  );

  return server;
}

app.get("/", (c) => {
  return c.text("Slack MCP Server - Use /mcp endpoint for MCP communication");
});

app.get("/health", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    // Simple health check - count workspaces
    const workspaceCount = await db.select().from(schema.workspaces).limit(1);
    
    return c.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: "connected"
    });
  } catch (error) {
    return c.json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      database: "disconnected",
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});

// MCP endpoint
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
      description: "MCP server for Slack workspace integration with message posting and retrieval capabilities"
    },
  }));
});

app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));

export default app;
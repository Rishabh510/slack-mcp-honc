import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { eq, desc, and, gte } from "drizzle-orm";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
};

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
        const authTest = await slack.auth.test();
        
        if (!authTest.ok || !authTest.team || !authTest.team_id || !authTest.url || !authTest.user_id) {
          return {
            content: [{
              type: "text",
              text: "Invalid bot token or missing workspace information"
            }],
            isError: true
          };
        }

        // Check if workspace already exists
        const existingWorkspace = await db.select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.teamId, authTest.team_id))
          .limit(1);

        if (existingWorkspace.length > 0) {
          // Update existing workspace
          const [updatedWorkspace] = await db.update(schema.workspaces)
            .set({
              teamName: authTest.team,
              workspaceUrl: authTest.url,
              botToken: bot_token,
              userId: user_id,
              botId: authTest.user_id,
              description: description || null,
              updatedAt: new Date(),
              isActive: true
            })
            .where(eq(schema.workspaces.teamId, authTest.team_id))
            .returning();

          return {
            content: [{
              type: "text",
              text: `Workspace updated successfully!\n\nWorkspace ID: ${updatedWorkspace.id}\nTeam: ${updatedWorkspace.teamName}\nURL: ${updatedWorkspace.workspaceUrl}\nDescription: ${updatedWorkspace.description || 'None'}`
            }]
          };
        }

        // Create new workspace
        const [newWorkspace] = await db.insert(schema.workspaces)
          .values({
            teamName: authTest.team,
            teamId: authTest.team_id,
            workspaceUrl: authTest.url,
            botToken: bot_token,
            userId: user_id,
            botId: authTest.user_id,
            description: description || null
          })
          .returning();

        return {
          content: [{
            type: "text",
            text: `Workspace configured successfully!\n\nWorkspace ID: ${newWorkspace.id}\nTeam: ${newWorkspace.teamName}\nURL: ${newWorkspace.workspaceUrl}\nDescription: ${newWorkspace.description || 'None'}\n\nYou can now use this workspace ID for other Slack operations.`
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
    {},
    async () => {
      try {
        const workspaces = await db.select({
          teamName: schema.workspaces.teamName,
          description: schema.workspaces.description
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.isActive, true));

        if (workspaces.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No workspaces configured yet. Use configure_workspace to add one."
            }]
          };
        }

        const workspaceList = workspaces.map(ws => 
          `• ${ws.teamName}${ws.description ? ` - ${ws.description}` : ''}`
        ).join('\n');

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
          .where(and(
            eq(schema.workspaces.id, workspace_id),
            eq(schema.workspaces.isActive, true)
          ))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found or inactive"
            }],
            isError: true
          };
        }

        const slack = new WebClient(workspace.botToken);

        // Calculate timestamp for days_back
        const oldestTimestamp = Math.floor((Date.now() - (days_back * 24 * 60 * 60 * 1000)) / 1000);

        // Get channel history
        const history = await slack.conversations.history({
          channel: channel_id,
          oldest: oldestTimestamp.toString(),
          limit: 200 // Get more messages to filter through
        });

        if (!history.ok || !history.messages) {
          return {
            content: [{
              type: "text",
              text: "Failed to retrieve channel history or no messages found"
            }],
            isError: true
          };
        }

        // Filter for mentions and channel notifications
        const mentionPattern = new RegExp(`<@${workspace.userId}>`, 'i');
        const channelNotificationPattern = /<!channel>/i;

        const mentions = history.messages
          .filter(msg => {
            const text = msg.text || '';
            return mentionPattern.test(text) || channelNotificationPattern.test(text);
          })
          .slice(0, limit)
          .map(msg => {
            const timestamp = msg.ts ? new Date(Number.parseFloat(msg.ts) * 1000).toISOString() : 'Unknown';
            const permalink = `${workspace.workspaceUrl}archives/${channel_id}/p${msg.ts?.replace('.', '')}`;
            
            return {
              text: msg.text || '',
              user: msg.user || 'Unknown',
              timestamp,
              permalink
            };
          });

        if (mentions.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No mentions or channel notifications found in the last ${days_back} day(s)`
            }]
          };
        }

        const mentionsList = mentions.map(mention => 
          `• ${mention.text}\n  User: ${mention.user}\n  Time: ${mention.timestamp}\n  Link: ${mention.permalink}`
        ).join('\n\n');

        return {
          content: [{
            type: "text",
            text: `Found ${mentions.length} mention(s) in the last ${days_back} day(s):\n\n${mentionsList}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      limit: z.number().min(1).max(100).default(10).describe("Maximum number of channels to return"),
      private_only: z.boolean().default(false).describe("Show only private channels")
    },
    async ({ workspace_id, limit, private_only }) => {
      try {
        // Get workspace
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(and(
            eq(schema.workspaces.id, workspace_id),
            eq(schema.workspaces.isActive, true)
          ))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found or inactive"
            }],
            isError: true
          };
        }

        const slack = new WebClient(workspace.botToken);
        const channels = [];

        // Get public channels if not private_only
        if (!private_only) {
          const publicChannels = await slack.conversations.list({
            types: 'public_channel',
            limit
          });

          if (publicChannels.ok && publicChannels.channels) {
            channels.push(...publicChannels.channels.map(ch => ({
              id: ch.id,
              name: ch.name,
              type: 'public',
              is_member: ch.is_member
            })));
          }
        }

        // Get private channels
        const privateChannels = await slack.conversations.list({
          types: 'private_channel',
          limit: private_only ? limit : Math.max(1, limit - channels.length)
        });

        if (privateChannels.ok && privateChannels.channels) {
          channels.push(...privateChannels.channels.map(ch => ({
            id: ch.id,
            name: ch.name,
            type: 'private',
            is_member: ch.is_member
          })));
        }

        if (channels.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No channels found"
            }]
          };
        }

        const channelsList = channels
          .slice(0, limit)
          .map(ch => `• #${ch.name} (${ch.type}) - ID: ${ch.id}${ch.is_member ? ' ✓' : ''}`)
          .join('\n');

        return {
          content: [{
            type: "text",
            text: `Channels (✓ = member):\n\n${channelsList}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      channel_id: z.string().min(1).describe("Target channel ID to post message to"),
      message_text: z.string().min(1).describe("Message content to post")
    },
    async ({ workspace_id, channel_id, message_text }) => {
      try {
        // Get workspace
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(and(
            eq(schema.workspaces.id, workspace_id),
            eq(schema.workspaces.isActive, true)
          ))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found or inactive"
            }],
            isError: true
          };
        }

        const slack = new WebClient(workspace.botToken);

        // Get channel info for name
        const channelInfo = await slack.conversations.info({
          channel: channel_id
        });

        const channelName = channelInfo.ok && channelInfo.channel ? 
          channelInfo.channel.name || channel_id : channel_id;

        // Post the message
        const result = await slack.chat.postMessage({
          channel: channel_id,
          text: message_text
        });

        if (!result.ok || !result.ts) {
          return {
            content: [{
              type: "text",
              text: "Failed to post message to Slack"
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
            messageTs: result.ts,
            slackMessageId: result.message?.client_msg_id || null,
            userId: workspace.userId
          })
          .returning();

        const permalink = `${workspace.workspaceUrl}archives/${channel_id}/p${result.ts.replace('.', '')}`;

        return {
          content: [{
            type: "text",
            text: `Message posted successfully!\n\nChannel: #${channelName}\nMessage: ${message_text}\nLink: ${permalink}\nMessage ID: ${postedMessage.id}`
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
      workspace_id: z.string().min(1).describe("Unique workspace ID from configure_workspace"),
      limit: z.number().min(1).max(100).default(50).describe("Maximum number of messages to return")
    },
    async ({ workspace_id, limit }) => {
      try {
        // Get workspace to verify it exists
        const [workspace] = await db.select()
          .from(schema.workspaces)
          .where(and(
            eq(schema.workspaces.id, workspace_id),
            eq(schema.workspaces.isActive, true)
          ))
          .limit(1);

        if (!workspace) {
          return {
            content: [{
              type: "text",
              text: "Workspace not found or inactive"
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
              text: "No messages have been posted through this MCP server yet"
            }]
          };
        }

        const messagesList = messages.map(msg => {
          const timestamp = msg.createdAt.toISOString();
          const permalink = `${workspace.workspaceUrl}archives/${msg.channelId}/p${msg.messageTs.replace('.', '')}`;
          
          return `• #${msg.channelName}: ${msg.messageText}\n  Posted: ${timestamp}\n  Link: ${permalink}`;
        }).join('\n\n');

        return {
          content: [{
            type: "text",
            text: `Posted Messages (${messages.length}):\n\n${messagesList}`
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
  return c.text("Slack MCP Server - Use /mcp endpoint for MCP communication");
});

app.get("/health", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    // Simple database connectivity check
    await db.select().from(schema.workspaces).limit(1);
    
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
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// REST API endpoint for posting messages
app.post("/api/post-message", async (c) => {
  try {
    const body = await c.req.json();
    const { workspace_id, channel_id, message_text } = body;

    // Validate required fields
    if (!workspace_id || !channel_id || !message_text) {
      return c.json({
        error: "Missing required fields: workspace_id, channel_id, message_text"
      }, 400);
    }

    const db = drizzle(c.env.DB);

    // Get workspace
    const [workspace] = await db.select()
      .from(schema.workspaces)
      .where(and(
        eq(schema.workspaces.id, workspace_id),
        eq(schema.workspaces.isActive, true)
      ))
      .limit(1);

    if (!workspace) {
      return c.json({
        error: "Workspace not found or inactive"
      }, 404);
    }

    const slack = new WebClient(workspace.botToken);

    // Get channel info for name
    const channelInfo = await slack.conversations.info({
      channel: channel_id
    });

    const channelName = channelInfo.ok && channelInfo.channel ? 
      channelInfo.channel.name || channel_id : channel_id;

    // Post the message
    const result = await slack.chat.postMessage({
      channel: channel_id,
      text: message_text
    });

    if (!result.ok || !result.ts) {
      return c.json({
        error: "Failed to post message to Slack",
        slack_error: result.error
      }, 500);
    }

    // Store the posted message in database
    const [postedMessage] = await db.insert(schema.postedMessages)
      .values({
        workspaceId: workspace_id,
        channelId: channel_id,
        channelName: channelName,
        messageText: message_text,
        messageTs: result.ts,
        slackMessageId: result.message?.client_msg_id || null,
        userId: workspace.userId
      })
      .returning();

    const permalink = `${workspace.workspaceUrl}archives/${channel_id}/p${result.ts.replace('.', '')}`;

    return c.json({
      success: true,
      data: {
        message_id: postedMessage.id,
        channel_name: channelName,
        channel_id: channel_id,
        message_text: message_text,
        slack_timestamp: result.ts,
        permalink: permalink,
        posted_at: new Date().toISOString()
      }
    });

  } catch (error) {
    return c.json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : 'Unknown error'
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
  }))
});

app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" }
}));

export default app;
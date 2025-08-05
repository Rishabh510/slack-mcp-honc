import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  teamName: text("team_name").notNull(),
  teamId: text("team_id").notNull().unique(),
  workspaceUrl: text("workspace_url").notNull(),
  botToken: text("bot_token").notNull(),
  userId: text("user_id").notNull(),
  botId: text("bot_id").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
}, (t) => [
  index("workspaces_team_id_idx").on(t.teamId),
  index("workspaces_user_id_idx").on(t.userId),
]);

export const postedMessages = sqliteTable("posted_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull(),
  messageText: text("message_text").notNull(),
  messageTs: text("message_ts").notNull(),
  slackMessageId: text("slack_message_id"),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (t) => [
  index("posted_messages_workspace_id_idx").on(t.workspaceId),
  index("posted_messages_channel_id_idx").on(t.channelId),
  index("posted_messages_user_id_idx").on(t.userId),
  index("posted_messages_created_at_idx").on(t.createdAt),
]);

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  postedMessages: many(postedMessages),
}));

export const postedMessagesRelations = relations(postedMessages, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [postedMessages.workspaceId],
    references: [workspaces.id],
  }),
}));
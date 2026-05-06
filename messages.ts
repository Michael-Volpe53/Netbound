import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

async function resolveUser(ctx: any, token: string) {
  const session = await ctx.db.query("sessions").withIndex("by_token", (q: any) => q.eq("token", token)).first();
  if (!session) return null;
  return session.username;
}

function convKey(a: string, b: string) {
  return [a, b].sort().join("::");
}

export const sendMessage = mutation({
  args: { token: v.string(), toUsername: v.string(), text: v.string() },
  handler: async (ctx, { token, toUsername, text }) => {
    const fromUsername = await resolveUser(ctx, token);
    if (!fromUsername) return { ok: false, error: "Not logged in." };
    if (!text.trim()) return { ok: false, error: "Empty message." };

    const key = convKey(fromUsername, toUsername);
    const [u1, u2] = key.split("::");
    const areFriends = await ctx.db.query("friends")
      .withIndex("by_pair", (q: any) => q.eq("user1", u1).eq("user2", u2))
      .first();
    if (!areFriends) return { ok: false, error: "Not friends." };

    await ctx.db.insert("messages", {
      fromUsername,
      toUsername,
      convKey: key,
      text: text.trim(),
      createdAt: Date.now(),
      read: false,
    });
    return { ok: true };
  },
});

export const markRead = mutation({
  args: { token: v.string(), otherUsername: v.string() },
  handler: async (ctx, { token, otherUsername }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return;
    const key = convKey(username, otherUsername);
    const msgs = await ctx.db.query("messages")
      .withIndex("by_conv", (q: any) => q.eq("convKey", key))
      .collect();
    for (const m of msgs) {
      if (m.toUsername === username && !m.read) {
        await ctx.db.patch(m._id, { read: true });
      }
    }
  },
});

export const getUnreadCount = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return 0;
    const unread = await ctx.db.query("messages")
      .withIndex("by_to_unread", (q: any) => q.eq("toUsername", username).eq("read", false))
      .collect();
    return unread.length;
  },
});

export const getMessages = query({
  args: { token: v.string(), otherUsername: v.string() },
  handler: async (ctx, { token, otherUsername }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const key = convKey(username, otherUsername);
    const msgs = await ctx.db.query("messages")
      .withIndex("by_conv", (q: any) => q.eq("convKey", key))
      .order("asc")
      .collect();

    // Get other user's profile for color/emoji
    const otherUser = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", otherUsername)).first();

    return msgs.map((m: any) => ({
      _id: m._id,
      fromUsername: m.fromUsername,
      toUsername: m.toUsername,
      text: m.text,
      createdAt: m.createdAt,
      isMe: m.fromUsername === username,
      read: m.read,
      otherColor: otherUser?.color ?? "#5b7fff",
      otherEmoji: otherUser?.emoji ?? "🦊",
    }));
  },
});

export const getConversationPreviews = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const asUser1 = await ctx.db.query("friends").withIndex("by_user1", (q: any) => q.eq("user1", username)).collect();
    const asUser2 = await ctx.db.query("friends").withIndex("by_user2", (q: any) => q.eq("user2", username)).collect();
    const friendUsernames = [
      ...asUser1.map((f: any) => f.user2),
      ...asUser2.map((f: any) => f.user1),
    ];

    const ONLINE_THRESHOLD = 2 * 60 * 1000; // 2 minutes

    const previews = await Promise.all(
      friendUsernames.map(async (fu: string) => {
        const key = convKey(username, fu);
        const lastMsg = await ctx.db.query("messages")
          .withIndex("by_conv", (q: any) => q.eq("convKey", key))
          .order("desc")
          .first();
        const friendUser = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", fu)).first();

        // Count unread
        const allMsgs = await ctx.db.query("messages")
          .withIndex("by_conv", (q: any) => q.eq("convKey", key))
          .collect();
        const unread = allMsgs.filter((m: any) => m.toUsername === username && !m.read).length;

        const isOnline = friendUser?.lastSeen ? (Date.now() - friendUser.lastSeen) < ONLINE_THRESHOLD : false;

        return {
          username: fu,
          alias: friendUser?.alias ?? fu,
          color: friendUser?.color ?? "#5b7fff",
          emoji: friendUser?.emoji ?? "🦊",
          isOnline,
          unread,
          lastMessage: lastMsg ? { text: lastMsg.text, from: lastMsg.fromUsername, ts: lastMsg.createdAt } : null,
        };
      })
    );

    return previews.sort((a: any, b: any) => {
      const ta = a.lastMessage?.ts ?? 0;
      const tb = b.lastMessage?.ts ?? 0;
      return tb - ta;
    });
  },
});
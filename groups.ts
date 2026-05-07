import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

async function resolveUser(ctx: any, token: string) {
  const session = await ctx.db.query("sessions").withIndex("by_token", (q: any) => q.eq("token", token)).first();
  if (!session) return null;
  return session.username;
}

// Create a new group chat
export const createGroup = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    memberUsernames: v.array(v.string()),
  },
  handler: async (ctx, { token, name, memberUsernames }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    if (!name.trim() || name.trim().length < 1) return { ok: false, error: "Group name required." };
    if (name.trim().length > 32) return { ok: false, error: "Name too long (max 32 chars)." };
    if (memberUsernames.length < 1) return { ok: false, error: "Add at least one other person." };
    if (memberUsernames.length > 19) return { ok: false, error: "Max 20 members." };

    // Verify all added members are friends
    const allMembers = [username, ...memberUsernames.filter(u => u !== username)];

    const groupId = await ctx.db.insert("groupChats", {
      name: name.trim(),
      members: allMembers,
      createdBy: username,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    });

    // Mark creator as read from the start
    await ctx.db.insert("groupReads", {
      groupId,
      username,
      lastReadAt: Date.now(),
    });

    return { ok: true, groupId };
  },
});

// Send a message in a group
export const sendGroupMessage = mutation({
  args: { token: v.string(), groupId: v.id("groupChats"), text: v.string() },
  handler: async (ctx, { token, groupId, text }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    if (!text.trim()) return { ok: false, error: "Empty message." };

    const group = await ctx.db.get(groupId);
    if (!group) return { ok: false, error: "Group not found." };
    if (!group.members.includes(username)) return { ok: false, error: "Not a member." };

    await ctx.db.insert("groupMessages", {
      groupId,
      fromUsername: username,
      text: text.trim(),
      createdAt: Date.now(),
    });

    await ctx.db.patch(groupId, { lastMessageAt: Date.now() });

    // Update read receipt for sender
    const readRow = await ctx.db.query("groupReads")
      .withIndex("by_group_user", (q: any) => q.eq("groupId", groupId).eq("username", username))
      .first();
    if (readRow) {
      await ctx.db.patch(readRow._id, { lastReadAt: Date.now() });
    } else {
      await ctx.db.insert("groupReads", { groupId, username, lastReadAt: Date.now() });
    }

    return { ok: true };
  },
});

// Mark group as read
export const markGroupRead = mutation({
  args: { token: v.string(), groupId: v.id("groupChats") },
  handler: async (ctx, { token, groupId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return;
    const existing = await ctx.db.query("groupReads")
      .withIndex("by_group_user", (q: any) => q.eq("groupId", groupId).eq("username", username))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastReadAt: Date.now() });
    } else {
      await ctx.db.insert("groupReads", { groupId, username, lastReadAt: Date.now() });
    }
  },
});

// Leave a group
export const leaveGroup = mutation({
  args: { token: v.string(), groupId: v.id("groupChats") },
  handler: async (ctx, { token, groupId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };
    const group = await ctx.db.get(groupId);
    if (!group) return { ok: false };

    const newMembers = group.members.filter((m: string) => m !== username);
    if (newMembers.length === 0) {
      // Delete group if everyone left
      const msgs = await ctx.db.query("groupMessages").withIndex("by_group", (q: any) => q.eq("groupId", groupId)).collect();
      for (const m of msgs) await ctx.db.delete(m._id);
      const reads = await ctx.db.query("groupReads").withIndex("by_group_user", (q: any) => q.eq("groupId", groupId)).collect();
      for (const r of reads) await ctx.db.delete(r._id);
      await ctx.db.delete(groupId);
    } else {
      await ctx.db.patch(groupId, { members: newMembers });
    }
    return { ok: true };
  },
});

// Get all groups the user is in (for sidebar)
export const getMyGroups = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const allGroups = await ctx.db.query("groupChats").withIndex("by_created").order("desc").collect();
    const myGroups  = allGroups.filter((g: any) => g.members.includes(username));

    const ONLINE_THRESHOLD = 2 * 60 * 1000;

    return await Promise.all(myGroups.map(async (g: any) => {
      // Last message
      const lastMsg = await ctx.db.query("groupMessages")
        .withIndex("by_group", (q: any) => q.eq("groupId", g._id))
        .order("desc")
        .first();

      // Unread count — messages after user's lastReadAt
      const readRow = await ctx.db.query("groupReads")
        .withIndex("by_group_user", (q: any) => q.eq("groupId", g._id).eq("username", username))
        .first();
      const lastReadAt = readRow?.lastReadAt ?? 0;

      const recentMsgs = await ctx.db.query("groupMessages")
        .withIndex("by_group", (q: any) => q.eq("groupId", g._id))
        .order("desc")
        .take(50);
      const unread = recentMsgs.filter((m: any) => m.fromUsername !== username && m.createdAt > lastReadAt).length;

      // Member profiles
      const memberProfiles = await Promise.all(
        g.members.slice(0, 4).map(async (mu: string) => {
          const u = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", mu)).first();
          return { username: mu, emoji: u?.emoji ?? "🦊", color: u?.color ?? "#5b7fff", alias: u?.alias ?? mu };
        })
      );

      return {
        _id: g._id,
        name: g.name,
        members: g.members,
        memberProfiles,
        createdBy: g.createdBy,
        lastMessageAt: g.lastMessageAt ?? g.createdAt,
        lastMessage: lastMsg ? { text: lastMsg.text, fromUsername: lastMsg.fromUsername, ts: lastMsg.createdAt } : null,
        unread,
      };
    }));
  },
});

// Get messages in a group
export const getGroupMessages = query({
  args: { token: v.string(), groupId: v.id("groupChats") },
  handler: async (ctx, { token, groupId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const group = await ctx.db.get(groupId);
    if (!group || !group.members.includes(username)) return [];

    const msgs = await ctx.db.query("groupMessages")
      .withIndex("by_group", (q: any) => q.eq("groupId", groupId))
      .order("asc")
      .collect();

    // Enrich with sender profile
    const profileCache: Record<string, any> = {};
    return await Promise.all(msgs.map(async (m: any) => {
      if (!profileCache[m.fromUsername]) {
        const u = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", m.fromUsername)).first();
        profileCache[m.fromUsername] = { emoji: u?.emoji ?? "🦊", color: u?.color ?? "#5b7fff", alias: u?.alias ?? m.fromUsername };
      }
      const profile = profileCache[m.fromUsername];
      return {
        _id: m._id,
        fromUsername: m.fromUsername,
        text: m.text,
        createdAt: m.createdAt,
        isMe: m.fromUsername === username,
        senderEmoji: profile.emoji,
        senderColor: profile.color,
        senderAlias: profile.alias,
      };
    }));
  },
});

// Get total unread group message count
export const getGroupUnreadCount = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return 0;

    const allGroups = await ctx.db.query("groupChats").withIndex("by_created").collect();
    const myGroups  = allGroups.filter((g: any) => g.members.includes(username));

    let total = 0;
    for (const g of myGroups) {
      const readRow = await ctx.db.query("groupReads")
        .withIndex("by_group_user", (q: any) => q.eq("groupId", g._id).eq("username", username))
        .first();
      const lastReadAt = readRow?.lastReadAt ?? 0;
      const recent = await ctx.db.query("groupMessages")
        .withIndex("by_group", (q: any) => q.eq("groupId", g._id))
        .order("desc")
        .take(50);
      total += recent.filter((m: any) => m.fromUsername !== username && m.createdAt > lastReadAt).length;
    }
    return total;
  },
});
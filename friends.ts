import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ONLINE_THRESHOLD = 2 * 60 * 1000; // 2 minutes

async function resolveUser(ctx: any, token: string) {
  const session = await ctx.db.query("sessions").withIndex("by_token", (q: any) => q.eq("token", token)).first();
  if (!session) return null;
  return session.username;
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join("::");
}

export const sendRequest = mutation({
  args: { token: v.string(), toAlias: v.string() },
  handler: async (ctx, { token, toAlias }) => {
    const fromUsername = await resolveUser(ctx, token);
    if (!fromUsername) return { ok: false, error: "Not logged in." };

    const toUser = await ctx.db.query("users").withIndex("by_alias", (q: any) => q.eq("alias", toAlias)).first();
    if (!toUser) return { ok: false, error: "No user with that alias found." };
    if (toUser.username === fromUsername) return { ok: false, error: "That's you!" };

    const key = pairKey(fromUsername, toUser.username);
    const [f1, f2] = key.split("::");
    const alreadyFriends = await ctx.db.query("friends").withIndex("by_pair", (q: any) => q.eq("user1", f1).eq("user2", f2)).first();
    if (alreadyFriends) return { ok: false, error: "Already friends." };

    const existing = await ctx.db.query("friendRequests")
      .withIndex("by_pair", (q: any) => q.eq("fromUsername", fromUsername).eq("toUsername", toUser.username))
      .filter((q: any) => q.eq(q.field("status"), "pending"))
      .first();
    if (existing) return { ok: false, error: "Request already sent." };

    const reverse = await ctx.db.query("friendRequests")
      .withIndex("by_pair", (q: any) => q.eq("fromUsername", toUser.username).eq("toUsername", fromUsername))
      .filter((q: any) => q.eq(q.field("status"), "pending"))
      .first();
    if (reverse) {
      await ctx.db.patch(reverse._id, { status: "accepted" });
      await ctx.db.insert("friends", { user1: f1, user2: f2, createdAt: Date.now() });
      return { ok: true, message: "You were already requested — now friends!" };
    }

    await ctx.db.insert("friendRequests", {
      fromUsername, toUsername: toUser.username, status: "pending", createdAt: Date.now(),
    });
    return { ok: true, message: "Friend request sent!" };
  },
});

export const respondRequest = mutation({
  args: { token: v.string(), requestId: v.id("friendRequests"), accept: v.boolean() },
  handler: async (ctx, { token, requestId, accept }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };

    const req = await ctx.db.get(requestId);
    if (!req || req.toUsername !== username) return { ok: false, error: "Not found." };

    await ctx.db.patch(requestId, { status: accept ? "accepted" : "declined" });

    if (accept) {
      const key = pairKey(req.fromUsername, req.toUsername);
      const [u1, u2] = key.split("::");
      await ctx.db.insert("friends", { user1: u1, user2: u2, createdAt: Date.now() });
    }
    return { ok: true };
  },
});

export const removeFriend = mutation({
  args: { token: v.string(), friendUsername: v.string() },
  handler: async (ctx, { token, friendUsername }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };
    const key = pairKey(username, friendUsername);
    const [u1, u2] = key.split("::");
    const row = await ctx.db.query("friends").withIndex("by_pair", (q: any) => q.eq("user1", u1).eq("user2", u2)).first();
    if (row) await ctx.db.delete(row._id);
    return { ok: true };
  },
});

export const getMyFriends = query({
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

    const friends = await Promise.all(
      friendUsernames.map(async (fu: string) => {
        const user = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", fu)).first();
        if (!user) return null;
        const isOnline = user.lastSeen ? (Date.now() - user.lastSeen) < ONLINE_THRESHOLD : false;
        return {
          username: fu,
          alias: user.alias,
          bio: user.bio ?? "",
          color: user.color ?? "#5b7fff",
          emoji: user.emoji ?? "🦊",
          isOnline,
        };
      })
    );
    return friends.filter(Boolean);
  },
});

export const getInboxRequests = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const reqs = await ctx.db.query("friendRequests")
      .withIndex("by_to", (q: any) => q.eq("toUsername", username))
      .collect();

    return await Promise.all(reqs.map(async (r: any) => {
      const fromUser = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", r.fromUsername)).first();
      return {
        ...r,
        fromAlias: fromUser?.alias ?? r.fromUsername,
        fromColor: fromUser?.color ?? "#5b7fff",
        fromEmoji: fromUser?.emoji ?? "🦊",
      };
    }));
  },
});

export const getSentRequests = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];
    return await ctx.db.query("friendRequests")
      .withIndex("by_from", (q: any) => q.eq("fromUsername", username))
      .filter((q: any) => q.eq(q.field("status"), "pending"))
      .collect();
  },
});

export const getAllUsers = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];
    const all = await ctx.db.query("users").collect();
    return all
      .filter((u: any) => u.username !== username)
      .map((u: any) => ({
        username: u.username,
        alias: u.alias,
        bio: u.bio ?? "",
        color: u.color ?? "#5b7fff",
        emoji: u.emoji ?? "🦊",
        isOnline: u.lastSeen ? (Date.now() - u.lastSeen) < ONLINE_THRESHOLD : false,
      }));
  },
});

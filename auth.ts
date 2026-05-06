import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ADJS = ["Silent","Crimson","Golden","Ivory","Shadow","Neon","Cobalt","Mystic","Arctic","Velvet","Jade","Amber","Silver","Onyx","Coral","Phantom","Russet","Indigo","Sage","Dusk","Lunar","Solar","Cosmic","Storm","Swift","Brave","Calm","Bold","Wild","Sharp","Frozen","Hollow","Ashen","Bitter","Clever","Daring","Eager","Faint","Gentle","Humble"];
const ANIMALS = ["Fox","Wolf","Hawk","Lynx","Bear","Crow","Deer","Otter","Seal","Raven","Owl","Mink","Hare","Puma","Elk","Viper","Crane","Bison","Swan","Kite","Wren","Toad","Mole","Pike","Finch","Moose","Badger","Quail","Stoat","Ibis","Gecko","Shrew","Bream","Dingo","Egret","Ferret","Grebe","Heron","Iguana","Jackal"];

function genAlias() {
  return ADJS[Math.floor(Math.random() * ADJS.length)] + ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
}
function genToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const register = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, { username, password }) => {
    if (username.length < 2) return { ok: false, error: "Username too short." };
    if (password.length < 4) return { ok: false, error: "Password must be at least 4 characters." };
    const existing = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", username)).first();
    if (existing) return { ok: false, error: "Username already taken." };

    let alias = genAlias();
    for (let i = 0; i < 50; i++) {
      const taken = await ctx.db.query("users").withIndex("by_alias", q => q.eq("alias", alias)).first();
      if (!taken) break;
      alias = genAlias();
    }

    await ctx.db.insert("users", {
      username, passwordHash: btoa(password), alias, createdAt: Date.now(),
      lastSeen: Date.now(), bio: "", color: "#5b7fff", emoji: "🦊",
    });
    const token = genToken();
    await ctx.db.insert("sessions", { username, token, createdAt: Date.now() });
    return { ok: true, token, alias };
  },
});

export const login = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, { username, password }) => {
    const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", username)).first();
    if (!user || user.passwordHash !== btoa(password)) return { ok: false, error: "Wrong username or password." };
    const token = genToken();
    await ctx.db.insert("sessions", { username, token, createdAt: Date.now() });
    await ctx.db.patch(user._id, { lastSeen: Date.now() });
    return { ok: true, token, alias: user.alias };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db.query("sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (session) {
      const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", session.username)).first();
      if (user) await ctx.db.patch(user._id, { lastSeen: 0 });
      await ctx.db.delete(session._id);
    }
    return { ok: true };
  },
});

export const heartbeat = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db.query("sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (!session) return { ok: false };
    const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", session.username)).first();
    if (user) await ctx.db.patch(user._id, { lastSeen: Date.now() });
    return { ok: true };
  },
});

export const updateProfile = mutation({
  args: {
    token: v.string(),
    alias: v.optional(v.string()),
    bio: v.optional(v.string()),
    color: v.optional(v.string()),
    emoji: v.optional(v.string()),
  },
  handler: async (ctx, { token, alias, bio, color, emoji }) => {
    const session = await ctx.db.query("sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (!session) return { ok: false, error: "Not logged in." };
    const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", session.username)).first();
    if (!user) return { ok: false, error: "User not found." };

    const updates: any = {};
    if (alias !== undefined && alias !== user.alias) {
      if (alias.length < 2) return { ok: false, error: "Alias too short." };
      if (alias.length > 24) return { ok: false, error: "Alias too long." };
      const taken = await ctx.db.query("users").withIndex("by_alias", q => q.eq("alias", alias)).first();
      if (taken && taken._id !== user._id) return { ok: false, error: "Alias already taken." };
      updates.alias = alias;
    }
    if (bio !== undefined) updates.bio = bio.slice(0, 160);
    if (color !== undefined) updates.color = color;
    if (emoji !== undefined) updates.emoji = emoji;
    await ctx.db.patch(user._id, updates);
    return { ok: true, alias: updates.alias ?? user.alias };
  },
});

export const getMe = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const session = await ctx.db.query("sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (!session) return null;
    const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", session.username)).first();
    if (!user) return null;
    return { username: user.username, alias: user.alias, bio: user.bio ?? "", color: user.color ?? "#5b7fff", emoji: user.emoji ?? "🦊" };
  },
});

export const getTotalUserCount = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("users").collect();
    return all.length;
  },
});

export const getUnreadNotifCount = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db.query("sessions").withIndex("by_token", q => q.eq("token", token)).first();
    if (!session) return 0;
    const unread = await ctx.db.query("notifications")
      .withIndex("by_to_unread", (q: any) => q.eq("toUsername", session.username).eq("read", false))
      .collect();
    return unread.length;
  },
});
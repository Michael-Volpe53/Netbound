import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const ADMIN_USERNAMES = ["michael-volpe"];

async function resolveUser(ctx: any, token: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .first();
  if (!session) return null;
  return session.username;
}

async function getProfile(ctx: any, username: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_username", (q: any) => q.eq("username", username))
    .first();

  if (!user) {
    return { alias: username, color: "#5b7fff", emoji: "🦊", bio: "", createdAt: 0, badges: [] };
  }

  // Read pre-computed stats directly — no nested queries needed
  const totalPostLikes = user.totalPostLikes ?? 0;
  const totalPosts     = user.totalPosts     ?? 0;
  const totalComments  = user.totalComments  ?? 0;
  const accountAgeDays = Math.floor((Date.now() - user.createdAt) / 86400000);

  const badges = computeBadges({
    totalPostLikes,
    totalPosts,
    totalComments,
    accountAgeDays,
    isTopLiked: false,
    isTopPoster: false,
    isMostActive: false,
  });

  if (username === "michael-volpe") {
    badges.push({ id: "owner", label: "Owner", icon: "🛠️", color: "#f5c518", desc: "" });
  }
  if (username === "test") {
    badges.push({ id: "tester", label: "Tester", icon: "🧪", color: "#2ecc8a", desc: "" });
  }

  return {
    alias: user.alias ?? username,
    color: user.color ?? "#5b7fff",
    emoji: user.emoji ?? "🦊",
    bio: user.bio ?? "",
    createdAt: user.createdAt,
    badges,
  };
}

export function computeBadges(stats: {
  totalPostLikes: number;
  totalPosts: number;
  totalComments: number;
  accountAgeDays: number;
  isTopPoster: boolean;
  isTopLiked: boolean;
  isMostActive: boolean;
}) {
  const badges: { id: string; label: string; icon: string; color: string; desc: string }[] = [];
  if (stats.isTopLiked)   badges.push({ id: "crown",   label: "Most Liked",   icon: "👑", color: "#f5c518", desc: "Holds the most liked post" });
  if (stats.isTopPoster)  badges.push({ id: "fire",    label: "Top Poster",   icon: "🔥", color: "#ff6b35", desc: "Most posts on the platform" });
  if (stats.isMostActive) badges.push({ id: "bolt",    label: "Most Active",  icon: "⚡", color: "#5b7fff", desc: "Most comments left" });
  if (stats.totalPostLikes >= 50) badges.push({ id: "star50",  label: "50 Likes",   icon: "⭐", color: "#f5c518", desc: "Earned 50 total post likes" });
  if (stats.totalPostLikes >= 10) badges.push({ id: "star10",  label: "10 Likes",   icon: "✨", color: "#8892ab", desc: "Earned 10 total post likes" });
  if (stats.totalPosts >= 25)     badges.push({ id: "posts25", label: "25 Posts",   icon: "📜", color: "#2ecc8a", desc: "Posted 25 times" });
  if (stats.totalPosts >= 5)      badges.push({ id: "posts5",  label: "5 Posts",    icon: "📝", color: "#8892ab", desc: "Posted 5 times" });
  if (stats.totalComments >= 20)  badges.push({ id: "chat20",  label: "Chatterbox", icon: "💬", color: "#00c2e0", desc: "Left 20+ comments" });
  if (stats.accountAgeDays >= 30) badges.push({ id: "og30",    label: "Veteran",    icon: "🏅", color: "#b362ff", desc: "Member for 30+ days" });
  if (stats.accountAgeDays >= 7)  badges.push({ id: "og7",     label: "Week Old",   icon: "🌱", color: "#2ecc8a", desc: "Member for 7+ days" });
  return badges;
}

// ── LEADERBOARD ──
// Previously: looped over every user and ran sub-queries for posts/comments per user → O(users × posts)
// Now: reads pre-computed totalPostLikes/totalPosts/totalComments directly from users table → O(users)
export const getLeaderboard = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return null;

    const allUsers = await ctx.db.query("users").collect();

    const userStats = allUsers.map((u: any) => {
      const totalPostLikes = u.totalPostLikes ?? 0;
      const totalPosts     = u.totalPosts     ?? 0;
      const totalComments  = u.totalComments  ?? 0;
      const accountAgeDays = Math.floor((Date.now() - u.createdAt) / 86400000);
      return {
        username:     u.username,
        alias:        u.alias,
        color:        u.color        ?? "#5b7fff",
        emoji:        u.emoji        ?? "🦊",
        bio:          u.bio          ?? "",
        totalPostLikes,
        totalPosts,
        totalComments,
        accountAgeDays,
      };
    });

    const maxLikes    = Math.max(...userStats.map((u: any) => u.totalPostLikes), 0);
    const maxPosts    = Math.max(...userStats.map((u: any) => u.totalPosts),     0);
    const maxComments = Math.max(...userStats.map((u: any) => u.totalComments),  0);

    const enriched = userStats.map((u: any) => {
      const isTopLiked   = u.totalPostLikes === maxLikes    && maxLikes    > 0;
      const isTopPoster  = u.totalPosts     === maxPosts    && maxPosts    > 0;
      const isMostActive = u.totalComments  === maxComments && maxComments > 0;
      const badges = computeBadges({
        totalPostLikes: u.totalPostLikes,
        totalPosts:     u.totalPosts,
        totalComments:  u.totalComments,
        accountAgeDays: u.accountAgeDays,
        isTopPoster,
        isTopLiked,
        isMostActive,
      });
      // Special badges
      if (u.username === "michael-volpe") badges.push({ id: "owner", label: "Owner", icon: "🛠️", color: "#f5c518", desc: "" });
      if (u.username === "test")          badges.push({ id: "tester", label: "Tester", icon: "🧪", color: "#2ecc8a", desc: "" });
      return { ...u, badges, isTopLiked, isTopPoster, isMostActive };
    });

    enriched.sort((a: any, b: any) => b.totalPostLikes - a.totalPostLikes);

    // Top post: still needs one query but it's a single indexed scan, not per-user
    const recentPosts = await ctx.db.query("posts").withIndex("by_created").order("desc").take(500);
    const topPost = recentPosts.length > 0
      ? recentPosts.reduce((best: any, p: any) => (p.likeCount > (best?.likeCount ?? -1) ? p : best), null)
      : null;

    let topPostData = null;
    if (topPost) {
      const author = await getProfile(ctx, topPost.authorUsername);
      topPostData = { ...topPost, ...author };
    }

    return { users: enriched, topPost: topPostData };
  },
});

export const getChangelog = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];
    return await ctx.db.query("changelog").withIndex("by_created").order("desc").take(50);
  },
});

export const createChangelog = mutation({
  args: {
    token: v.string(), title: v.string(), body: v.string(),
    version: v.optional(v.string()),
    tag: v.union(v.literal("feature"), v.literal("fix"), v.literal("improvement"), v.literal("upcoming")),
  },
  handler: async (ctx, { token, title, body, version, tag }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    if (!ADMIN_USERNAMES.includes(username)) return { ok: false, error: "Admin only." };
    await ctx.db.insert("changelog", { authorUsername: username, title, body, version, tag, createdAt: Date.now() });
    return { ok: true };
  },
});

export const deleteChangelog = mutation({
  args: { token: v.string(), entryId: v.id("changelog") },
  handler: async (ctx, { token, entryId }) => {
    const username = await resolveUser(ctx, token);
    if (!username || !ADMIN_USERNAMES.includes(username)) return { ok: false };
    await ctx.db.delete(entryId);
    return { ok: true };
  },
});

export const getPolls = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];
    const polls = await ctx.db.query("polls").withIndex("by_created").order("desc").take(20);
    return await Promise.all(polls.map(async (poll: any) => {
      const votes = await ctx.db.query("pollVotes").withIndex("by_poll", (q: any) => q.eq("pollId", poll._id)).collect();
      const myVote = votes.find((v: any) => v.username === username);
      const optionCounts = poll.options.map((_: string, i: number) => votes.filter((v: any) => v.optionIndex === i).length);
      const isExpired = poll.endsAt ? Date.now() > poll.endsAt : false;
      return { ...poll, optionCounts, totalVotes: votes.length, myVoteIndex: myVote?.optionIndex ?? null, isClosed: poll.closed || isExpired };
    }));
  },
});

export const createPoll = mutation({
  args: { token: v.string(), question: v.string(), options: v.array(v.string()), endsAt: v.optional(v.number()) },
  handler: async (ctx, { token, question, options, endsAt }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    if (!ADMIN_USERNAMES.includes(username)) return { ok: false, error: "Admin only." };
    if (options.length < 2 || options.length > 6) return { ok: false, error: "2–6 options required." };
    await ctx.db.insert("polls", { authorUsername: username, question, options, endsAt, createdAt: Date.now(), closed: false });
    return { ok: true };
  },
});

export const votePoll = mutation({
  args: { token: v.string(), pollId: v.id("polls"), optionIndex: v.number() },
  handler: async (ctx, { token, pollId, optionIndex }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    const poll = await ctx.db.get(pollId);
    if (!poll) return { ok: false, error: "Poll not found." };
    if (poll.closed) return { ok: false, error: "Poll is closed." };
    if (poll.endsAt && Date.now() > poll.endsAt) return { ok: false, error: "Poll has ended." };
    if (optionIndex < 0 || optionIndex >= poll.options.length) return { ok: false, error: "Invalid option." };
    const existing = await ctx.db.query("pollVotes").withIndex("by_poll_user", (q: any) => q.eq("pollId", pollId).eq("username", username)).first();
    if (existing) { await ctx.db.patch(existing._id, { optionIndex }); }
    else { await ctx.db.insert("pollVotes", { pollId, username, optionIndex, createdAt: Date.now() }); }
    return { ok: true };
  },
});

export const closePoll = mutation({
  args: { token: v.string(), pollId: v.id("polls") },
  handler: async (ctx, { token, pollId }) => {
    const username = await resolveUser(ctx, token);
    if (!username || !ADMIN_USERNAMES.includes(username)) return { ok: false };
    await ctx.db.patch(pollId, { closed: true });
    return { ok: true };
  },
});

export const deletePoll = mutation({
  args: { token: v.string(), pollId: v.id("polls") },
  handler: async (ctx, { token, pollId }) => {
    const username = await resolveUser(ctx, token);
    if (!username || !ADMIN_USERNAMES.includes(username)) return { ok: false };
    const votes = await ctx.db.query("pollVotes").withIndex("by_poll", (q: any) => q.eq("pollId", pollId)).collect();
    for (const v of votes) await ctx.db.delete(v._id);
    await ctx.db.delete(pollId);
    return { ok: true };
  },
});

export const getIdeas = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];
    const ideas = await ctx.db.query("ideas").withIndex("by_created").order("desc").take(100);
    const enriched = await Promise.all(ideas.map(async (idea: any) => {
      const author = await getProfile(ctx, idea.authorUsername);
      const myVote = await ctx.db.query("ideaVotes").withIndex("by_idea_user", (q: any) => q.eq("ideaId", idea._id).eq("username", username)).first();
      return { ...idea, alias: author.alias, color: author.color, emoji: author.emoji, isMe: idea.authorUsername === username, hasVoted: !!myVote };
    }));
    enriched.sort((a: any, b: any) => b.voteCount - a.voteCount);
    return enriched;
  },
});

export const submitIdea = mutation({
  args: { token: v.string(), text: v.string() },
  handler: async (ctx, { token, text }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    if (!text.trim() || text.trim().length < 5) return { ok: false, error: "Idea too short." };
    if (text.trim().length > 200) return { ok: false, error: "Max 200 characters." };
    const existing = await ctx.db.query("ideas").withIndex("by_author", (q: any) => q.eq("authorUsername", username)).first();
    if (existing) return { ok: false, error: "You already have an idea posted. Delete it first." };
    await ctx.db.insert("ideas", { authorUsername: username, text: text.trim(), createdAt: Date.now(), voteCount: 0 });
    return { ok: true };
  },
});

export const deleteIdea = mutation({
  args: { token: v.string(), ideaId: v.id("ideas") },
  handler: async (ctx, { token, ideaId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };
    const idea = await ctx.db.get(ideaId);
    if (!idea) return { ok: false };
    if (idea.authorUsername !== username && !ADMIN_USERNAMES.includes(username)) return { ok: false, error: "Not authorized." };
    const votes = await ctx.db.query("ideaVotes").withIndex("by_idea", (q: any) => q.eq("ideaId", ideaId)).collect();
    for (const v of votes) await ctx.db.delete(v._id);
    await ctx.db.delete(ideaId);
    return { ok: true };
  },
});

export const voteIdea = mutation({
  args: { token: v.string(), ideaId: v.id("ideas") },
  handler: async (ctx, { token, ideaId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    const idea = await ctx.db.get(ideaId);
    if (!idea) return { ok: false, error: "Idea not found." };
    const existing = await ctx.db.query("ideaVotes").withIndex("by_idea_user", (q: any) => q.eq("ideaId", ideaId).eq("username", username)).first();
    if (existing) {
      await ctx.db.delete(existing._id);
      await ctx.db.patch(ideaId, { voteCount: Math.max(0, idea.voteCount - 1) });
    } else {
      await ctx.db.insert("ideaVotes", { ideaId, username, createdAt: Date.now() });
      await ctx.db.patch(ideaId, { voteCount: idea.voteCount + 1 });
    }
    return { ok: true };
  },
});

export const getIsAdmin = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    return ADMIN_USERNAMES.includes(username ?? "");
  },
});

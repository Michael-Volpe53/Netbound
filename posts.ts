import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

async function resolveUser(ctx: any, token: string) {
  const session = await ctx.db.query("sessions").withIndex("by_token", (q: any) => q.eq("token", token)).first();
  if (!session) return null;
  return session.username;
}

async function getAuthorProfile(ctx: any, username: string) {
  const user = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", username)).first();
  return {
    alias: user?.alias ?? username,
    color: user?.color ?? "#5b7fff",
    emoji: user?.emoji ?? "🦊",
    bio: user?.bio ?? "",
  };
}

// Helper: increment a numeric field on a user record safely
async function bumpUserStat(ctx: any, username: string, field: string, delta: number) {
  const user = await ctx.db.query("users").withIndex("by_username", (q: any) => q.eq("username", username)).first();
  if (!user) return;
  const current = (user as any)[field] ?? 0;
  await ctx.db.patch(user._id, { [field]: Math.max(0, current + delta) });
}

// ── CREATE POST ──
export const createPost = mutation({
  args: {
    token: v.string(),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("video"), v.literal("link")),
    text: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    linkTitle: v.optional(v.string()),
  },
  handler: async (ctx, { token, type, text, mediaUrl, linkTitle }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false, error: "Not logged in." };
    if (!text && !mediaUrl) return { ok: false, error: "Post is empty." };
    if (text && text.trim().length === 0) return { ok: false, error: "Post is empty." };

    const postId = await ctx.db.insert("posts", {
      authorUsername: username,
      type,
      text: text?.trim(),
      mediaUrl,
      linkTitle,
      createdAt: Date.now(),
      likeCount: 0,
      dislikeCount: 0,
    });

    // Increment user's post count
    await bumpUserStat(ctx, username, "totalPosts", 1);

    return { ok: true, postId };
  },
});

// ── DELETE POST ──
export const deletePost = mutation({
  args: { token: v.string(), postId: v.id("posts") },
  handler: async (ctx, { token, postId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };
    const post = await ctx.db.get(postId);
    if (!post || post.authorUsername !== username) return { ok: false, error: "Not authorized." };

    // Delete all reactions and comments
    const reactions = await ctx.db.query("postReactions").withIndex("by_post", (q: any) => q.eq("postId", postId)).collect();
    for (const r of reactions) await ctx.db.delete(r._id);

    const comments = await ctx.db.query("comments").withIndex("by_post", (q: any) => q.eq("postId", postId)).collect();
    for (const c of comments) {
      const cReactions = await ctx.db.query("commentReactions").withIndex("by_comment", (q: any) => q.eq("commentId", c._id)).collect();
      for (const cr of cReactions) await ctx.db.delete(cr._id);
      await ctx.db.delete(c._id);
    }

    await ctx.db.delete(postId);

    // Decrement user's post count and remove this post's likes from their total
    await bumpUserStat(ctx, username, "totalPosts", -1);
    await bumpUserStat(ctx, username, "totalPostLikes", -(post.likeCount ?? 0));

    // Also decrement totalComments for each comment author
    for (const c of comments) {
      await bumpUserStat(ctx, c.authorUsername, "totalComments", -1);
    }

    return { ok: true };
  },
});

// ── REACT TO POST ──
export const reactToPost = mutation({
  args: {
    token: v.string(),
    postId: v.id("posts"),
    reaction: v.union(v.literal("like"), v.literal("dislike")),
  },
  handler: async (ctx, { token, postId, reaction }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };

    const post = await ctx.db.get(postId);
    if (!post) return { ok: false };

    const existing = await ctx.db.query("postReactions")
      .withIndex("by_post_user", (q: any) => q.eq("postId", postId).eq("username", username))
      .first();

    if (existing) {
      if (existing.reaction === reaction) {
        // Toggle off
        await ctx.db.delete(existing._id);
        await ctx.db.patch(postId, {
          likeCount: Math.max(0, post.likeCount + (reaction === "like" ? -1 : 0)),
          dislikeCount: Math.max(0, post.dislikeCount + (reaction === "dislike" ? -1 : 0)),
        });
        // If un-liking, decrement author's totalPostLikes
        if (reaction === "like") {
          await bumpUserStat(ctx, post.authorUsername, "totalPostLikes", -1);
        }
      } else {
        // Switch reaction (like→dislike or dislike→like)
        await ctx.db.patch(existing._id, { reaction });
        await ctx.db.patch(postId, {
          likeCount: post.likeCount + (reaction === "like" ? 1 : -1),
          dislikeCount: post.dislikeCount + (reaction === "dislike" ? 1 : -1),
        });
        // Switching to like = +1, switching away from like = -1
        await bumpUserStat(ctx, post.authorUsername, "totalPostLikes", reaction === "like" ? 1 : -1);
      }
    } else {
      // New reaction
      await ctx.db.insert("postReactions", { postId, username, reaction, createdAt: Date.now() });
      await ctx.db.patch(postId, {
        likeCount: post.likeCount + (reaction === "like" ? 1 : 0),
        dislikeCount: post.dislikeCount + (reaction === "dislike" ? 1 : 0),
      });

      // Increment author's totalPostLikes if this is a like
      if (reaction === "like") {
        await bumpUserStat(ctx, post.authorUsername, "totalPostLikes", 1);
      }

      // Notify post author if liked (not yourself)
      if (reaction === "like" && post.authorUsername !== username) {
        const actor = await getAuthorProfile(ctx, username);
        await ctx.db.insert("notifications", {
          toUsername: post.authorUsername,
          fromAlias: actor.alias,
          fromColor: actor.color,
          fromEmoji: actor.emoji,
          type: "post_like",
          postId,
          postSnippet: (post.text ?? "").slice(0, 60),
          read: false,
          createdAt: Date.now(),
        });
      }
    }
    return { ok: true };
  },
});

// ── ADD COMMENT ──
export const addComment = mutation({
  args: { token: v.string(), postId: v.id("posts"), text: v.string() },
  handler: async (ctx, { token, postId, text }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };
    if (!text.trim()) return { ok: false };

    const commentId = await ctx.db.insert("comments", {
      postId,
      authorUsername: username,
      text: text.trim(),
      createdAt: Date.now(),
      likeCount: 0,
      dislikeCount: 0,
    });

    // Increment user's comment count
    await bumpUserStat(ctx, username, "totalComments", 1);

    return { ok: true, commentId };
  },
});

// ── DELETE COMMENT ──
export const deleteComment = mutation({
  args: { token: v.string(), commentId: v.id("comments") },
  handler: async (ctx, { token, commentId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };
    const comment = await ctx.db.get(commentId);
    if (!comment) return { ok: false };

    // Allow comment author OR post author to delete
    const post = await ctx.db.get(comment.postId);
    if (comment.authorUsername !== username && post?.authorUsername !== username) {
      return { ok: false, error: "Not authorized." };
    }

    const reactions = await ctx.db.query("commentReactions").withIndex("by_comment", (q: any) => q.eq("commentId", commentId)).collect();
    for (const r of reactions) await ctx.db.delete(r._id);
    await ctx.db.delete(commentId);

    // Decrement comment author's totalComments
    await bumpUserStat(ctx, comment.authorUsername, "totalComments", -1);

    return { ok: true };
  },
});

// ── REACT TO COMMENT ──
export const reactToComment = mutation({
  args: {
    token: v.string(),
    commentId: v.id("comments"),
    reaction: v.union(v.literal("like"), v.literal("dislike")),
  },
  handler: async (ctx, { token, commentId, reaction }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return { ok: false };

    const comment = await ctx.db.get(commentId);
    if (!comment) return { ok: false };

    const existing = await ctx.db.query("commentReactions")
      .withIndex("by_comment_user", (q: any) => q.eq("commentId", commentId).eq("username", username))
      .first();

    if (existing) {
      if (existing.reaction === reaction) {
        await ctx.db.delete(existing._id);
        await ctx.db.patch(commentId, {
          likeCount: Math.max(0, comment.likeCount + (reaction === "like" ? -1 : 0)),
          dislikeCount: Math.max(0, comment.dislikeCount + (reaction === "dislike" ? -1 : 0)),
        });
      } else {
        await ctx.db.patch(existing._id, { reaction });
        await ctx.db.patch(commentId, {
          likeCount: comment.likeCount + (reaction === "like" ? 1 : -1),
          dislikeCount: comment.dislikeCount + (reaction === "dislike" ? 1 : -1),
        });
      }
    } else {
      await ctx.db.insert("commentReactions", { commentId, username, reaction, createdAt: Date.now() });
      await ctx.db.patch(commentId, {
        likeCount: comment.likeCount + (reaction === "like" ? 1 : 0),
        dislikeCount: comment.dislikeCount + (reaction === "dislike" ? 1 : 0),
      });

      // Notify comment author if liked (not yourself)
      if (reaction === "like" && comment.authorUsername !== username) {
        const actor = await getAuthorProfile(ctx, username);
        await ctx.db.insert("notifications", {
          toUsername: comment.authorUsername,
          fromAlias: actor.alias,
          fromColor: actor.color,
          fromEmoji: actor.emoji,
          type: "comment_like",
          postId: comment.postId,
          postSnippet: comment.text.slice(0, 60),
          read: false,
          createdAt: Date.now(),
        });
      }
    }
    return { ok: true };
  },
});

// ── GET FEED (all posts, newest first) ──
export const getFeed = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const posts = await ctx.db.query("posts")
      .withIndex("by_created")
      .order("desc")
      .take(100);

    return await enrichPosts(ctx, posts, username);
  },
});

// ── GET TRENDING (top liked posts) ──
export const getTrending = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const posts = await ctx.db.query("posts")
      .withIndex("by_created")
      .order("desc")
      .take(200);

    const scored = posts.map((p: any) => ({ ...p, score: p.likeCount - p.dislikeCount }));
    scored.sort((a: any, b: any) => b.score - a.score);
    const top = scored.slice(0, 50);

    return await enrichPosts(ctx, top, username);
  },
});

// ── GET COMMENTS FOR POST ──
export const getComments = query({
  args: { token: v.string(), postId: v.id("posts") },
  handler: async (ctx, { token, postId }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];

    const comments = await ctx.db.query("comments")
      .withIndex("by_post", (q: any) => q.eq("postId", postId))
      .order("asc")
      .collect();

    return await Promise.all(comments.map(async (c: any) => {
      const profile = await getAuthorProfile(ctx, c.authorUsername);
      const myReaction = await ctx.db.query("commentReactions")
        .withIndex("by_comment_user", (q: any) => q.eq("commentId", c._id).eq("username", username))
        .first();
      return {
        ...c,
        ...profile,
        isMe: c.authorUsername === username,
        myReaction: myReaction?.reaction ?? null,
      };
    }));
  },
});

// ── NOTIFICATIONS ──
export const getNotifications = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return [];
    const notifs = await ctx.db.query("notifications")
      .withIndex("by_to", (q: any) => q.eq("toUsername", username))
      .order("desc")
      .take(50);
    return notifs;
  },
});

export const markNotificationsRead = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const username = await resolveUser(ctx, token);
    if (!username) return;
    const unread = await ctx.db.query("notifications")
      .withIndex("by_to_unread", (q: any) => q.eq("toUsername", username).eq("read", false))
      .collect();
    for (const n of unread) await ctx.db.patch(n._id, { read: true });
  },
});

// ── HELPER ──
async function enrichPosts(ctx: any, posts: any[], username: string) {
  return await Promise.all(posts.map(async (p: any) => {
    const profile = await getAuthorProfile(ctx, p.authorUsername);
    const myReaction = await ctx.db.query("postReactions")
      .withIndex("by_post_user", (q: any) => q.eq("postId", p._id).eq("username", username))
      .first();
    const commentCount = await ctx.db.query("comments")
      .withIndex("by_post", (q: any) => q.eq("postId", p._id))
      .collect();
    return {
      ...p,
      ...profile,
      isMe: p.authorUsername === username,
      myReaction: myReaction?.reaction ?? null,
      commentCount: commentCount.length,
    };
  }));
}

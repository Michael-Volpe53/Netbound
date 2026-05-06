import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
    passwordHash: v.string(),
    alias: v.string(),
    createdAt: v.number(),
    bio: v.optional(v.string()),
    color: v.optional(v.string()),
    emoji: v.optional(v.string()),
    lastSeen: v.optional(v.number()),
  })
    .index("by_username", ["username"])
    .index("by_alias", ["alias"]),

  sessions: defineTable({
    username: v.string(),
    token: v.string(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"]),

  friendRequests: defineTable({
    fromUsername: v.string(),
    toUsername: v.string(),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("declined")),
    createdAt: v.number(),
  })
    .index("by_to", ["toUsername", "status"])
    .index("by_from", ["fromUsername"])
    .index("by_pair", ["fromUsername", "toUsername"]),

  friends: defineTable({
    user1: v.string(),
    user2: v.string(),
    createdAt: v.number(),
  })
    .index("by_user1", ["user1"])
    .index("by_user2", ["user2"])
    .index("by_pair", ["user1", "user2"]),

  messages: defineTable({
    fromUsername: v.string(),
    toUsername: v.string(),
    convKey: v.string(),
    text: v.string(),
    createdAt: v.number(),
    read: v.optional(v.boolean()),
  })
    .index("by_conv", ["convKey", "createdAt"])
    .index("by_to_unread", ["toUsername", "read"]),

  posts: defineTable({
    authorUsername: v.string(),
    type: v.union(v.literal("text"), v.literal("image"), v.literal("video"), v.literal("link")),
    text: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    linkTitle: v.optional(v.string()),
    createdAt: v.number(),
    likeCount: v.number(),
    dislikeCount: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_author", ["authorUsername"]),

  postReactions: defineTable({
    postId: v.id("posts"),
    username: v.string(),
    reaction: v.union(v.literal("like"), v.literal("dislike")),
    createdAt: v.number(),
  })
    .index("by_post", ["postId"])
    .index("by_post_user", ["postId", "username"]),

  comments: defineTable({
    postId: v.id("posts"),
    authorUsername: v.string(),
    text: v.string(),
    createdAt: v.number(),
    likeCount: v.number(),
    dislikeCount: v.number(),
  })
    .index("by_post", ["postId", "createdAt"]),

  commentReactions: defineTable({
    commentId: v.id("comments"),
    username: v.string(),
    reaction: v.union(v.literal("like"), v.literal("dislike")),
    createdAt: v.number(),
  })
    .index("by_comment", ["commentId"])
    .index("by_comment_user", ["commentId", "username"]),

  notifications: defineTable({
    toUsername: v.string(),
    fromAlias: v.string(),
    fromColor: v.string(),
    fromEmoji: v.string(),
    type: v.union(v.literal("post_like"), v.literal("comment_like"), v.literal("friend_request")),
    postId: v.optional(v.id("posts")),
    postSnippet: v.optional(v.string()),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_to", ["toUsername", "createdAt"])
    .index("by_to_unread", ["toUsername", "read"]),
});
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const claim = mutation({
  args: { updateId: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("telegramDedup")
      .withIndex("by_update_id", (q) => q.eq("updateId", args.updateId))
      .unique();
    if (existing) return { claimed: false };
    await ctx.db.insert("telegramDedup", {
      updateId: args.updateId,
      claimedAt: Date.now(),
    });
    return { claimed: true };
  },
});

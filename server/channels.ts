import { sendImessage, startTypingLoop as startSendblueTyping } from "./sendblue.js";
import { sendTelegram, startTypingLoop as startTelegramTyping } from "./telegram.js";

export async function sendToConversation(conversationId: string, text: string): Promise<void> {
  if (conversationId.startsWith("sms:")) {
    await sendImessage(conversationId.slice(4), text);
    return;
  }
  if (conversationId.startsWith("tg:")) {
    await sendTelegram(conversationId.slice(3), text);
    return;
  }
  // No external channel — used by the /chat HTTP endpoint and other internal
  // callers. The reply is still persisted in Convex by the caller.
}

export function startTypingLoop(conversationId: string): () => void {
  if (conversationId.startsWith("sms:")) {
    return startSendblueTyping(conversationId.slice(4));
  }
  if (conversationId.startsWith("tg:")) {
    return startTelegramTyping(conversationId.slice(3));
  }
  return () => {};
}

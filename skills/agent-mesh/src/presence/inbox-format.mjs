/**
 * Formats claimed inbox messages into the text block shown to the human and the model.
 * Standalone (no imports) so in-process plugins can load it cheaply.
 * @param {Array<object>} messages
 * @returns {string}
 */
export function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const header = `[AGENT-MESH INBOX NOTIFICATION: ${messages.length} pending message(s)]`;
  const body = messages
    .map((m) => {
      const fromStr = m.from_agent || "unknown";
      const ticketStr = m.id || "none";
      const hopsStr = m.hops !== undefined ? ` | Hops: ${m.hops}` : "";
      return `--- Message from [${fromStr}] (Ticket: ${ticketStr}${hopsStr}) ---\n${m.body}`;
    })
    .join("\n\n");
  const replyInstr = `\n\nTo reply, run: mesh reply --ticket <id> --to <agent> "<your response>"`;
  return `${header}\n\n${body}${replyInstr}`;
}

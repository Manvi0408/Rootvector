/** Outbound Slack notification via an Incoming Webhook URL (SLACK_WEBHOOK_URL).
 *  No-op when the URL isn't configured, so the app runs fine without Slack. */
export async function notifySlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* never let a notification failure break the incident pipeline */
  }
}

/** Post a message to a Slack Incoming Webhook URL. No-op without a URL. */
export async function postSlack(url: string | null | undefined, text: string): Promise<void> {
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

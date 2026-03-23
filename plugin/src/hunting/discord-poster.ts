// Posts messages to Discord channels using bot token + REST API

const DISCORD_API = 'https://discord.com/api/v10';

export class DiscordPoster {
  constructor(
    private botToken: string,
    private channelId: string
  ) {}

  async post(content: string): Promise<{ success: boolean; error?: string }> {
    // Discord has a 2000 char limit per message — split if needed
    const chunks = this.splitMessage(content, 1900);

    for (let i = 0; i < chunks.length; i++) {
      // Rate limit: wait 1s between chunks
      if (i > 0) await new Promise(r => setTimeout(r, 1000));

      try {
        const response = await fetch(`${DISCORD_API}/channels/${this.channelId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${this.botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: chunks[i] }),
        });

        if (response.status === 429) {
          // Rate limited — wait and retry
          const data = await response.json() as { retry_after: number };
          const waitMs = (data.retry_after ?? 1) * 1000 + 500;
          await new Promise(r => setTimeout(r, waitMs));
          // Retry this chunk
          i--;
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, error: `Discord API ${response.status}: ${errText}` };
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { success: true };
  }

  async dm(userId: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Create DM channel
      const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient_id: userId }),
      });

      if (!dmRes.ok) {
        return { success: false, error: `Failed to create DM channel: ${dmRes.status}` };
      }

      const dmChannel = await dmRes.json() as { id: string };

      // Send message
      const msgRes = await fetch(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      });

      if (!msgRes.ok) {
        return { success: false, error: `Failed to send DM: ${msgRes.status}` };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private splitMessage(content: string, maxLen: number): string[] {
    if (content.length <= maxLen) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Split at last newline before maxLen
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = maxLen;

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }
}

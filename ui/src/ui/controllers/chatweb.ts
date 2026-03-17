import type { OpenClawApp } from "../app.ts";

export async function loadChatWebStatus(host: OpenClawApp): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  host.chatWebLoading = true;
  try {
    const res = await host.client.request<{
      enabled: boolean;
      browser: "chrome" | "edge";
      aiAssistant: "chatgpt" | "claude";
      chatgpt: { loggedIn: boolean; hasStorage: boolean };
      claude: { loggedIn: boolean; hasStorage: boolean };
    }>("chatweb.status", {});
    host.chatWebStatus = res;
  } catch (err) {
    host.lastError = String(err);
  } finally {
    host.chatWebLoading = false;
  }
}

export async function startChatWebLogin(host: OpenClawApp): Promise<void> {
  if (!host.client || !host.connected || !host.chatWebStatus) {
    return;
  }
  host.chatWebLoading = true;
  try {
    const res = await host.client.request<{ sessionKey: string }>("chatweb.login.start", {
      aiAssistant: host.chatWebStatus.aiAssistant,
      browser: host.chatWebStatus.browser,
    });
    host.chatWebLoginSessionKey = res.sessionKey;
  } catch (err) {
    host.lastError = String(err);
  } finally {
    host.chatWebLoading = false;
  }
}

export async function confirmChatWebLogin(host: OpenClawApp): Promise<void> {
  if (!host.client || !host.connected || !host.chatWebLoginSessionKey) {
    return;
  }
  host.chatWebLoading = true;
  try {
    await host.client.request("chatweb.login.confirm", {
      sessionKey: host.chatWebLoginSessionKey,
    });
    host.chatWebLoginSessionKey = null;
    await loadChatWebStatus(host);
  } catch (err) {
    host.lastError = String(err);
  } finally {
    host.chatWebLoading = false;
  }
}

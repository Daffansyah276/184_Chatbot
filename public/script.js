const STORAGE_KEY = "ruang-ai-conversations";
const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const characterCount = document.querySelector("#characterCount");
const welcomeView = document.querySelector("#welcomeView");
const conversationView = document.querySelector("#conversationView");
const messagesElement = document.querySelector("#messages");
const historyList = document.querySelector("#historyList");
const historyEmpty = document.querySelector("#historyEmpty");
const sidebar = document.querySelector("#sidebar");
const sidebarBackdrop = document.querySelector("#sidebarBackdrop");

let conversations = loadConversations();
let activeConversationId = null;
let activeController = null;
let isGenerating = false;

function loadConversations() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored)
      ? stored.filter((conversation) =>
          conversation &&
          typeof conversation.id === "string" &&
          Array.isArray(conversation.messages)
        )
      : [];
  } catch (error) {
    console.warn("Riwayat percakapan tidak dapat dibaca.", error);
    return [];
  }
}

function saveConversations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch (error) {
    console.warn("Riwayat percakapan tidak dapat disimpan.", error);
  }
}

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentConversation() {
  return conversations.find((conversation) => conversation.id === activeConversationId);
}

function setView(showConversation) {
  welcomeView.hidden = showConversation;
  conversationView.hidden = !showConversation;
}

function createAssistantAvatar() {
  const avatar = document.createElement("span");
  avatar.className = "avatar assistant-avatar";
  avatar.setAttribute("aria-label", "Ruang AI");
  avatar.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3.5 19 12l8.5 3-8.5 3-3 8.5-3-8.5-8.5-3 8.5-3L16 3.5Z"/></svg>';
  return avatar;
}

function appendMessage(role, content, options = {}) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  if (role === "assistant") message.append(createAssistantAvatar());

  const body = document.createElement("div");
  body.className = "message-body";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = role === "user" ? "Anda" : "Ruang AI";

  const bubble = document.createElement("div");
  bubble.className = options.typing ? "typing-indicator" : "message-bubble";
  if (options.typing) {
    bubble.setAttribute("aria-label", "Ruang AI sedang mengetik");
    bubble.innerHTML = "<span></span><span></span><span></span>";
  } else {
    bubble.textContent = content;
  }

  body.append(author, bubble);
  message.append(body);

  if (role === "user") {
    const avatar = document.createElement("span");
    avatar.className = "avatar user-avatar";
    avatar.textContent = "A";
    avatar.setAttribute("aria-label", "Anda");
    message.append(avatar);
  }

  messagesElement.append(message);
  scrollToLatest();
  return { message, bubble };
}

function scrollToLatest() {
  conversationView.scrollTop = conversationView.scrollHeight;
}

function renderMessages(conversation) {
  messagesElement.replaceChildren();
  conversation.messages.forEach((message) => appendMessage(message.role, message.content));
  setView(conversation.messages.length > 0);
  scrollToLatest();
}

function renderHistory() {
  historyList.replaceChildren();
  historyEmpty.hidden = conversations.length > 0;

  conversations.forEach((conversation) => {
    const button = document.createElement("button");
    button.className = `history-item${conversation.id === activeConversationId ? " active" : ""}`;
    button.type = "button";
    button.title = conversation.title;
    button.setAttribute("aria-current", conversation.id === activeConversationId ? "page" : "false");

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 5h16v12H8l-4 4V5Z");
    icon.append(path);

    const title = document.createElement("span");
    title.textContent = conversation.title;
    button.append(icon, title);
    button.addEventListener("click", () => {
      if (isGenerating) return;
      activeConversationId = conversation.id;
      renderHistory();
      renderMessages(conversation);
      closeSidebar();
    });
    historyList.append(button);
  });
}

function startNewChat() {
  if (isGenerating) return;
  activeConversationId = null;
  messagesElement.replaceChildren();
  setView(false);
  renderHistory();
  input.value = "";
  updateComposer();
  input.focus();
  closeSidebar();
}

function updateComposer() {
  characterCount.textContent = `${input.value.length} / 4000`;
  sendButton.disabled = !isGenerating && input.value.trim().length === 0;
  sendButton.classList.toggle("is-generating", isGenerating);
  sendButton.setAttribute("aria-label", isGenerating ? "Hentikan respons" : "Kirim pesan");
  form.setAttribute("aria-busy", String(isGenerating));
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function setGenerating(value) {
  isGenerating = value;
  updateComposer();
}

function closeSidebar() {
  sidebar.classList.remove("is-open");
  sidebarBackdrop.classList.remove("is-visible");
  document.body.classList.remove("sidebar-open");
}

function openSidebar() {
  sidebar.classList.add("is-open");
  sidebarBackdrop.classList.add("is-visible");
  document.body.classList.add("sidebar-open");
}

function getTitle(message) {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 29)}…` : normalized;
}

function parseStreamFrame(frame, onContent) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

  if (!data || data === "[DONE]") return;

  let value;
  try {
    value = JSON.parse(data);
  } catch {
    value = data;
  }

  if (value && typeof value === "object" && !Array.isArray(value) && value.error) {
    throw new Error(typeof value.error === "string" ? value.error : "Terjadi kesalahan dari layanan AI.");
  }

  if (typeof value === "string") onContent(value);
}

async function streamResponse(messages, signal, onContent) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal
  });

  if (!response.ok) {
    let detail = `Permintaan gagal (${response.status}).`;
    try {
      const errorData = await response.json();
      if (typeof errorData.error === "string") detail = errorData.error;
    } catch {
      const text = await response.text().catch(() => "");
      if (text) detail = text;
    }
    throw new Error(detail);
  }

  if (!response.body) throw new Error("Browser tidak mendukung respons streaming.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      frames.forEach((frame) => parseStreamFrame(frame, onContent));
    }

    buffer += decoder.decode();
    if (buffer.trim()) parseStreamFrame(buffer, onContent);
  } finally {
    reader.releaseLock();
  }
}

async function sendMessage(message) {
  let conversation = currentConversation();

  if (!conversation) {
    conversation = { id: createId(), title: getTitle(message), messages: [] };
    conversations.unshift(conversation);
    activeConversationId = conversation.id;
  }

  conversation.messages.push({ role: "user", content: message });
  saveConversations();
  renderHistory();
  setView(true);
  appendMessage("user", message);

  const typing = appendMessage("assistant", "", { typing: true });
  const assistantMessage = { role: "assistant", content: "" };
  conversation.messages.push(assistantMessage);
  activeController = new AbortController();
  setGenerating(true);
  renderHistory();

  try {
    await streamResponse(
      conversation.messages.slice(0, -1).map(({ role, content }) => ({ role, content })),
      activeController.signal,
      (chunk) => {
        typing.bubble.className = "message-bubble";
        assistantMessage.content += chunk;
        typing.bubble.textContent = assistantMessage.content;
        scrollToLatest();
      }
    );

    if (!assistantMessage.content) {
      assistantMessage.content = "Respons AI kosong. Silakan coba lagi.";
      typing.bubble.className = "message-bubble";
      typing.bubble.textContent = assistantMessage.content;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      if (!assistantMessage.content) {
        assistantMessage.content = "Respons dihentikan.";
        typing.bubble.className = "message-bubble";
        typing.bubble.textContent = assistantMessage.content;
      }
    } else {
      console.error("Gagal mengirim pesan:", error);
      assistantMessage.content = assistantMessage.content
        ? `${assistantMessage.content}\n\n[Respons terhenti: ${error.message}]`
        : `Maaf, pesan belum dapat diproses. ${error.message}`;
      typing.bubble.className = "message-bubble";
      typing.bubble.textContent = assistantMessage.content;
    }
  } finally {
    saveConversations();
    activeController = null;
    setGenerating(false);
    renderHistory();
    scrollToLatest();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isGenerating) {
    activeController?.abort();
    return;
  }

  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  updateComposer();
  sendMessage(message);
});

input.addEventListener("input", updateComposer);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll(".suggestion-card").forEach((button) => {
  button.addEventListener("click", () => {
    if (isGenerating) return;
    input.value = button.dataset.prompt || "";
    updateComposer();
    form.requestSubmit();
  });
});

document.querySelector("#newChatButton").addEventListener("click", startNewChat);
document.querySelector("#openSidebar").addEventListener("click", openSidebar);
document.querySelector("#closeSidebar").addEventListener("click", closeSidebar);
sidebarBackdrop.addEventListener("click", closeSidebar);
document.querySelector("#shareButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    const label = document.querySelector("#shareButton span");
    const original = label.textContent;
    label.textContent = "Tersalin";
    window.setTimeout(() => { label.textContent = original; }, 1600);
  } catch (error) {
    console.error("Tautan tidak dapat disalin:", error);
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
  if (event.key === "Escape") closeSidebar();
});

renderHistory();
updateComposer();
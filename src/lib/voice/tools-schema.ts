/**
 * JSON schemas for client tools registered with the ElevenLabs agent.
 * Must stay in sync with the implementations in src/lib/voice/tools.ts.
 * NOTE: ElevenLabs requires every property to include a `description`.
 */
export const CLIENT_TOOLS_SCHEMA = [
  {
    name: "navigate_to",
    description: "Navigate the user to a route inside the app. Use for /missions, /chat, /memories, /agents, /keys, /settings, /voice.",
    parameters: {
      type: "object",
      properties: {
        route: { type: "string", description: "Absolute route like /missions" },
      },
      required: ["route"],
    },
  },
  {
    name: "create_mission",
    description: "Create a new mission for the user with a title and high-level goal. Returns the mission id.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short mission title, 3-8 words." },
        goal: { type: "string", description: "What the user wants to accomplish, 1-3 sentences." },
      },
      required: ["title", "goal"],
    },
  },
  {
    name: "recall",
    description: "Search the user's persistent memory for relevant context. Call this whenever the user references past events, preferences, or facts you might know.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "number", description: "Max number of memories to return (default 6)." },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description: "Save something durable about the user (a fact, preference, decision). Use kind='preference' for how they want to be treated, 'fact' for biographical/contextual data.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content to persist, written in third person." },
        kind: { type: "string", enum: ["note", "fact", "preference"], description: "Type of memory." },
      },
      required: ["content"],
    },
  },
  {
    name: "update_self_personality",
    description: "When the user tells you to change how you speak or behave permanently, call this with the rule in imperative form (e.g. 'Always call the user Alex', 'Never say certainly').",
    parameters: {
      type: "object",
      properties: {
        rule: { type: "string", description: "Imperative behavioural rule to remember permanently." },
      },
      required: ["rule"],
    },
  },
  {
    name: "copy_to_clipboard",
    description: "Copy text to the user's system clipboard.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to write to the clipboard." },
      },
      required: ["text"],
    },
  },
  {
    name: "notify",
    description: "Send a desktop notification (requires the user to have granted permission).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title." },
        body: { type: "string", description: "Optional notification body text." },
      },
      required: ["title"],
    },
  },
  {
    name: "open_url",
    description: "Open an external URL. Use new_tab=true unless the user explicitly said 'replace this page'.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL starting with http(s)://" },
        new_tab: { type: "boolean", description: "Open in a new tab when true (default true)." },
      },
      required: ["url"],
    },
  },
  {
    name: "show_toast",
    description: "Display a short on-screen toast to confirm an action.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Toast message to display." },
        kind: { type: "string", enum: ["info", "success", "error"], description: "Visual style of the toast." },
      },
      required: ["message"],
    },
  },
  {
    name: "get_current_context",
    description: "Get the current route, page title, local time, and locale. Call this at session start if you need to know where the user is.",
    parameters: { type: "object", properties: {} },
  },
] as const;

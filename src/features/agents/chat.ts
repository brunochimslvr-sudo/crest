/*
 * The agents chat without its screen: which agents there are, what a project keeps, and what a turn sends.
 *
 * Tokens: each CLI keeps its own conversation, so an agent that has one is resumed and gets only what it has not seen.
 * That is nothing on a follow-up to the same agent. On a switch it is the short handoff below, and the agent reads the
 * project's files itself, which is why code in earlier replies is left out of it.
 */

export const AGENTS = {
  claude: { name: "Claude Code", models: ["sonnet", "opus", "haiku"] },
  codex: { name: "Codex", models: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"] },
  gemini: { name: "Antigravity", models: ["gemini-4-argon-medium", "gemini-3.8-flash-medium", "gemini-3.1-pro-high"] },
} as const;

export type Agent = keyof typeof AGENTS;
export const agentIds = Object.keys(AGENTS) as Agent[];
export const effortIds = ["low", "medium", "high"] as const;
export type Effort = (typeof effortIds)[number];

export type Message = { role: "user" | Agent; text: string; model?: string; tokens?: number; permissionDenied?: boolean };
export type Sessions = Partial<Record<Agent, string>>;
export type Project = { cwd: string; agent: Agent; model: string; effort: Effort; draft: string; messages: Message[]; sessions: Sessions };
export type Turn = { prompt: string; session?: string };

/** Everything a handoff may hold, and its share per message. */
const HANDOFF_CHARS = 2400;
const HANDOFF_MESSAGES = 8;
const LATEST_REPLY_CHARS = 1200;
const OLDER_REPLY_CHARS = 300;
const USER_CHARS = 400;

export const modelsOf = (agent: Agent): readonly string[] => AGENTS[agent].models;

/** A name short enough for a row of them. */
export const shortModel = (model: string) => model.replace(/^gemini-/, "").replace(/-(medium|high)$/, "");

/** How the projects come back from storage. A model the agent no longer offers would fail every turn. */
export function restoreProjects(saved: unknown): Project[] {
  if (!Array.isArray(saved)) return [];
  return saved.filter(isProject).map((project) => ({
    ...project,
    model: modelsOf(project.agent).includes(project.model) ? project.model : modelsOf(project.agent)[0],
    sessions: restoreSessions(project.sessions),
  }));
}

function isProject(project: Project): project is Project {
  return (
    typeof project?.cwd === "string" && agentIds.includes(project.agent) && effortIds.includes(project.effort) &&
    typeof project.model === "string" && typeof project.draft === "string" && Array.isArray(project.messages) &&
    project.messages.every((message: Message) => typeof message?.text === "string" && (message.role === "user" || agentIds.includes(message.role)))
  );
}

function restoreSessions(saved: unknown): Sessions {
  const sessions: Sessions = {};
  for (const agent of agentIds) {
    const id = (saved as Sessions | undefined)?.[agent];
    if (typeof id === "string" && id) sessions[agent] = id;
  }
  return sessions;
}

/** What goes to `agent` for this message, given what it already knows. */
export function planTurn(messages: Message[], agent: Agent, sessions: Sessions, text: string): Turn {
  const session = sessions[agent];
  if (!session) return { prompt: handoff(messages, text) };
  const unseen = messages.slice(messages.map((message) => message.role).lastIndexOf(agent) + 1);
  return { session, prompt: handoff(unseen, text) };
}

/** The newest messages, within the budget, for an agent that was not there. No messages: the text as it is. */
export function handoff(messages: Message[], text: string): string {
  const picked: string[] = [];
  let left = HANDOFF_CHARS;
  let newestReply = true;
  for (const message of messages.slice(-HANDOFF_MESSAGES).reverse()) {
    const speaker = message.role === "user" ? "User" : AGENTS[message.role].name;
    const room = left - speaker.length - 4;
    if (room < 40) break;
    const body = message.role === "user"
      ? keepStart(message.text, Math.min(USER_CHARS, room))
      : keepEnd(withoutCode(message.text), Math.min(newestReply ? LATEST_REPLY_CHARS : OLDER_REPLY_CHARS, room));
    if (message.role !== "user") newestReply = false;
    const entry = `${speaker}: ${body}`;
    picked.unshift(entry);
    left -= entry.length + 2;
  }
  if (!picked.length) return text;
  return ["Earlier in this project. Files may have changed since, so read them before relying on this.", ...picked, `New request:\n${text}`].join("\n\n");
}

/** Code an agent wrote is in the project's files, where the next one reads it anyway. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, "[code omitted]").replace(/\n{3,}/g, "\n\n").trim();
}

/** A user's message: what they asked comes first. Never cut through a character made of two code units. */
function keepStart(text: string, chars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= chars ? trimmed : `${trimmed.slice(0, chars - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** An agent's reply: its conclusion comes last. */
function keepEnd(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(1 - chars).replace(/^[\uDC00-\uDFFF]/, "")}`;
}

/** Tokens in the project's history, per model. */
export function tokensByModel(messages: Message[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const { role, model, tokens } of messages) {
    if (role !== "user" && model && Number.isFinite(tokens)) totals.set(model, (totals.get(model) ?? 0) + tokens!);
  }
  return totals;
}

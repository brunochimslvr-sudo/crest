import { useNowPlaying } from "../platform/media";
import { useDiscordCall } from "../features/discord/store";
import { useGamingLive } from "../features/system/gaming";
import { timer } from "../features/timer/store";
import { dueTasks } from "../features/todos/store";
import { waterDue } from "../features/water/store";
import { useAgentsNeedYou } from "../features/agents/store";

/**
 * Which tool opening the notch jumps to, by priority: gaming mode (turned on deliberately)
 * before time-critical (timer, due to-do, call, water) before background (music). The closed row shows them all side by side.
 */
export function useLiveActivity(): { id: string | null } {
  const gaming = useGamingLive();
  const t = timer.use();
  const call = useDiscordCall();
  const np = useNowPlaying();
  const reminder = dueTasks.use().length > 0;
  const drink = waterDue.use();
  const agentWaits = useAgentsNeedYou();
  if (gaming) return { id: "system" };
  // A due reminder waits for an answer, so it goes before a timer that is still running.
  if (t.finished) return { id: "timer" };
  if (reminder) return { id: "todos" };
  if (t.endsAt !== null) return { id: "timer" };
  if (call) return { id: "discord" };
  if (drink) return { id: "water" };
  // A coding session that waits for an answer holds up work, so it goes before music.
  if (agentWaits) return { id: "agents" };
  if (np?.isPlaying) return { id: "media" };
  return { id: null };
}

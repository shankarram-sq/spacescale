export { optionalTitle, requireDisplayName } from "./validation";

import { fallbackDisplayName } from "./validation";

export function randomDisplayName(actorId: string, owner = false): string {
  return owner ? `Owner ${fallbackDisplayName(actorId).slice(6)}` : fallbackDisplayName(actorId);
}

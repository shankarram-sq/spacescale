import type { BoardItem as ProtocolBoardItem } from "@collab/protocol";
import { serializeSvg } from "@collab/svg-export";
import type { BoardItem } from "./types";

export function serializeAuthoritativeSvg(input: {
  boardId: string;
  seq: number;
  title: string;
  items: readonly BoardItem[];
}): string {
  return serializeSvg({
    boardId: input.boardId,
    seq: input.seq,
    title: input.title,
    items: input.items as unknown as ProtocolBoardItem[],
  });
}

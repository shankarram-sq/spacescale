import type { Bounds } from "@collab/geometry";
import { MAX_BATCH_OPERATIONS, validateDurableOperation } from "@collab/protocol";

import type { BatchItemOperation, DurableOperation, NewBoardItem } from "../types";
import { createId, roundBoard } from "../types";

export type DecisionVoteOption = {
  label: string;
  count: number;
};

export type ClassDecisionProposal = {
  decisionTitle: string;
  chosenOption: string;
  rationale: string;
  minorityConcern: string;
  pilotAction: string;
  successMeasure: string;
  nextQuestion: string;
};

export type ClassDecisionBatch = {
  operation: Extract<DurableOperation, { kind: "items.batch" }>;
  itemIds: string[];
};

export function buildClassDecision(
  proposal: ClassDecisionProposal,
  voteOptions: readonly DecisionVoteOption[],
  voteBounds: Bounds,
  idFactory: () => string = createId,
): ClassDecisionBatch {
  const originX = roundBoard(voteBounds.maxX + 150);
  const originY = roundBoard(voteBounds.minY);
  const itemIds: string[] = [];
  const operations: BatchItemOperation[] = [];
  const add = (item: NewBoardItem): void => {
    itemIds.push(item.id);
    operations.push({
      kind: "item.create",
      item: { ...item, assistedBy: "ai" } as NewBoardItem,
    });
  };

  add({
    id: idFactory(),
    kind: "line",
    style: {
      kind: "line",
      color: "#6840a8",
      width: 4,
      opacity: 0.72,
      arrowhead: "arrow",
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x1: roundBoard((voteBounds.minX + voteBounds.maxX) / 2),
      y1: roundBoard((voteBounds.minY + voteBounds.maxY) / 2),
      x2: originX,
      y2: originY + 28,
    },
  });
  add({
    id: idFactory(),
    kind: "text",
    style: {
      kind: "text",
      color: "#4b2c82",
      fontSize: 30,
      fontFamily: "serif",
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: originX,
      y: originY + 34,
      text: proposal.decisionTitle,
    },
  });
  add({
    id: idFactory(),
    kind: "table",
    style: {
      kind: "table",
      borderColor: "#7956ae",
      fill: "#ffffff",
      headerFill: "#eee5ff",
      textColor: "#2f2936",
      fontSize: 15,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: originX,
      y: originY + 70,
      columnWidths: [260, 100],
      rowHeights: Array.from({ length: voteOptions.length + 1 }, () => 42),
      cells: [
        ["Class response", "Votes"],
        ...voteOptions.map((option) => [option.label, String(option.count)]),
      ],
      headerRow: true,
    },
  });

  const cardsY = originY + 70 + (voteOptions.length + 1) * 42 + 28;
  add(
    sticky(
      idFactory(),
      originX,
      cardsY,
      "#e5f5df",
      "#29452c",
      `CLASS CHOICE\n${proposal.chosenOption}\n\nWHY THIS DIRECTION\n${proposal.rationale}`,
    ),
  );
  add(
    sticky(
      idFactory(),
      originX + 300,
      cardsY,
      "#ffe7dd",
      "#5a342e",
      `DISSENT WE WILL NOT ERASE\n${proposal.minorityConcern}`,
    ),
  );
  add(
    sticky(
      idFactory(),
      originX,
      cardsY + 220,
      "#dff2ff",
      "#274353",
      `SMALL PILOT\n${proposal.pilotAction}\n\nWE WILL LOOK FOR\n${proposal.successMeasure}`,
    ),
  );
  add(
    sticky(
      idFactory(),
      originX + 300,
      cardsY + 220,
      "#eee5ff",
      "#38284f",
      `KEEP THE INQUIRY OPEN\n${proposal.nextQuestion}`,
    ),
  );

  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new Error("This class decision is too large for one shared update.");
  }
  return {
    operation: validateDurableOperation({
      kind: "items.batch",
      operations,
    }) as ClassDecisionBatch["operation"],
    itemIds,
  };
}

function sticky(
  id: string,
  x: number,
  y: number,
  fill: string,
  textColor: string,
  text: string,
): NewBoardItem {
  return {
    id,
    kind: "sticky",
    style: { kind: "sticky", fill, textColor, fontSize: 16, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x, y, width: 280, height: 196, text },
  };
}

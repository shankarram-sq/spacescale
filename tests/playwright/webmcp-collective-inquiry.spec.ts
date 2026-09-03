import { expect, test } from "@playwright/test";
import { createBoard } from "./helpers";

type RegisteredTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
};

declare global {
  interface Window {
    __spaceScaleWebMcpTools: Record<string, RegisteredTool>;
  }
}

test("a board participant can use headless WebMCP tools with neutral board attribution", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The WebMCP demo-path smoke runs in Chromium.");

  await page.addInitScript(() => {
    const tools: Record<string, RegisteredTool> = {};
    Object.defineProperty(window, "__spaceScaleWebMcpTools", { value: tools });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
          tools[tool.name] = tool;
          options?.signal?.addEventListener(
            "abort",
            () => {
              delete tools[tool.name];
            },
            { once: true },
          );
        },
      },
    });
  });

  await createBoard(page, "Collective inquiry demo");
  await page.getByTestId("settings-button").click();
  const settingsDrawer = page.getByTestId("settings-drawer");
  await settingsDrawer.getByRole("checkbox", { name: "Enable Images" }).check();
  await expect(page.getByTestId("toast-region")).toContainText("Images enabled.");
  await page.getByTestId("settings-button").click();
  await expect
    .poll(() => page.evaluate(() => Object.keys(window.__spaceScaleWebMcpTools).sort()))
    .toEqual([
      "add_collective_reasoning",
      "add_content_visuals",
      "add_group_decision_scaffold",
      "add_idea_sensemaking",
      "add_learning_action_plan",
      "add_thinking_expansion",
      "explain_selected_ideas",
      "inspect_selected_board_visual",
      "inspire_from_selected_ideas",
      "list_class_collaboration_modes",
      "read_live_class_vote",
      "read_selected_class_ideas",
      "stage_class_decision",
      "stage_collective_inquiry",
    ]);
  await expect(page.locator("[data-webmcp-status]")).toHaveCount(0);
  await expect(page.locator("[data-selection-ai]")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__spaceScaleWebMcpTools.read_selected_class_ideas?.annotations,
    ),
  ).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  const capabilities = await page.evaluate(async () => {
    const tool = window.__spaceScaleWebMcpTools.list_class_collaboration_modes;
    if (!tool) throw new Error("The collaboration capability tool was not registered.");
    return tool.execute({}, { signal: new AbortController().signal });
  });
  expect(capabilities).toMatchObject({
    availableModeCount: 27,
    textRendering: {
      engine: "MathJax 4",
      syntax: "TeX",
      surfaces: ["canvas_text", "sticky_notes", "table_cells", "section_titles", "comments"],
    },
    visualReader: {
      tool: "inspect_selected_board_visual",
      purpose: "handwriting_sketch_and_spatial_analysis",
      maximumItems: 40,
      result: "isolated_live_page_preview",
      unselectedBoardMasked: true,
      stableItemIdentifiersReturned: false,
      participantIdentifiersReturned: true,
      privateImages: "placeholder_only",
    },
    visualTool: {
      tool: "add_content_visuals",
      additions: { minimum: 1, maximum: 3 },
      formats: ["meme_card", "inline_image"],
      acceptedInlineImageMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      preferredGeneratedImageMimeType: "image/png",
      svgAccepted: false,
      externalImageUrlsAccepted: false,
    },
    guardrails: {
      boundedAdditions: true,
      studentDecisionsRemainBlank: true,
      inferredConsensus: false,
    },
    sectionIntegration: {
      live: false,
      reservedMode: "cross_group_jigsaw",
    },
  });
  const capabilityModes = (
    capabilities.families as Array<{
      modes: Array<{ requirements: string[]; inputContract: Record<string, unknown> }>;
    }>
  ).flatMap((family) => family.modes);
  expect(capabilityModes).toHaveLength(27);
  expect(
    capabilityModes.every(
      (mode) => mode.requirements.length >= 2 && mode.inputContract.entryCount !== undefined,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const schema = window.__spaceScaleWebMcpTools.add_thinking_expansion?.inputSchema;
      const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
      return {
        maxCards: properties?.cards?.maxItems,
        modes: properties?.mode?.enum,
      };
    }),
  ).toEqual({
    maxCards: 3,
    modes: [
      "gap_finder",
      "perspective_carousel",
      "idea_mashup",
      "constraint_shaker",
      "analogy_broker",
    ],
  });

  await page.getByTestId("activities-button").click();
  await page.getByTestId("activity-collective-inquiry-demo").click();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const canvasItems = page.locator("#drawing-area [data-item-id]");
  await expect(canvasItems).toHaveCount(13);

  const readResult = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.read_selected_class_ideas;
    if (!tool) throw new Error("The selected-ideas tool was not registered.");
    return tool.execute({}, { signal: new AbortController().signal });
  });
  expect(readResult.contributions).toHaveLength(8);
  const contributions = readResult.contributions as Array<{
    action: { type: string; objectKind: string };
    createdBy: { participantId: string; displayName: string };
  }>;
  expect(
    contributions.every(
      (contribution) =>
        contribution.action.type === "created" &&
        contribution.action.objectKind === "sticky" &&
        contribution.createdBy.participantId.length > 0 &&
        contribution.createdBy.displayName !== "Unknown participant",
    ),
  ).toBe(true);
  expect(JSON.stringify(readResult)).not.toContain("itemId");

  const guidedReads = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const inspire = window.__spaceScaleWebMcpTools.inspire_from_selected_ideas;
    const explain = window.__spaceScaleWebMcpTools.explain_selected_ideas;
    if (!inspire || !explain) throw new Error("The inspire/explain tools were not registered.");
    return Promise.all([inspire.execute({}, { signal }), explain.execute({}, { signal })]);
  });
  expect(guidedReads[0]).toMatchObject({
    purpose: "inspire",
    responseGuidance: {
      distinguishSourceFromSuggestion: true,
      preserveOriginalContributions: true,
    },
    textRendering: { engine: "MathJax 4" },
  });
  expect(guidedReads[1]).toMatchObject({
    purpose: "explain",
    responseGuidance: { citeSourceAliases: true, surfaceAmbiguity: true },
    textRendering: { engine: "MathJax 4" },
  });

  const rejectedSafeguards = await page.evaluate(
    async ({ selectionToken }) => {
      const card = (id: string) => ({
        id,
        heading: "Question",
        body: "Grounded in one selected contribution.",
        sourceAliases: ["idea_1"],
        question: "What evidence would change our mind?",
      });
      const attempts: Array<{ tool: string; input: Record<string, unknown> }> = [
        {
          tool: "add_thinking_expansion",
          input: {
            selectionToken,
            mode: "gap_finder",
            title: "Too many prompts",
            cards: [card("one"), card("two"), card("three"), card("four")],
            connections: [],
          },
        },
        {
          tool: "add_idea_sensemaking",
          input: {
            selectionToken,
            mode: "bridge_builder",
            title: "Not actually a bridge",
            cards: [card("one"), card("two")],
            connections: [],
          },
        },
        {
          tool: "add_group_decision_scaffold",
          input: {
            selectionToken,
            mode: "tradeoff_visualizer",
            title: "Not enough criteria",
            entries: [card("one"), card("two")],
            criteria: ["Impact"],
          },
        },
      ];
      const messages: string[] = [];
      for (const attempt of attempts) {
        const tool = window.__spaceScaleWebMcpTools[attempt.tool];
        if (!tool) throw new Error(`${attempt.tool} was not registered.`);
        try {
          await tool.execute(attempt.input, { signal: new AbortController().signal });
          messages.push("unexpected success");
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }
      return messages;
    },
    { selectionToken: readResult.selectionToken as string },
  );
  expect(rejectedSafeguards[0]).toContain("cards must contain 2-3 entries");
  expect(rejectedSafeguards[1]).toContain("connect at least 2 selected sources");
  expect(rejectedSafeguards[2]).toContain("criteria must contain 2-4 entries");

  const educationResults = await page.evaluate(
    async ({ selectionToken }) => {
      const moves: Array<{ name: string; input: Record<string, unknown> }> = [
        {
          name: "add_thinking_expansion",
          input: {
            selectionToken,
            mode: "gap_finder",
            title: "What the class has not asked yet",
            cards: [
              {
                id: "missing_voice",
                heading: "Whose lunch experience is missing?",
                body: "The ideas discuss waste and speed but not who may find a new routine harder.",
                sourceAliases: ["idea_1", "idea_2"],
                question: "Which students or staff could be affected differently by these changes?",
                role: "missing perspective",
              },
              {
                id: "missing_evidence",
                heading: "What baseline do we need?",
                body: "Several proposals assume where most waste happens without a shared observation yet.",
                sourceAliases: ["idea_3", "idea_4"],
                question: "What could the class measure before choosing a solution?",
                role: "evidence gap",
              },
            ],
            connections: [],
          },
        },
        {
          name: "add_idea_sensemaking",
          input: {
            selectionToken,
            mode: "alternative_clusterer",
            title: "Two ways to organize our ideas",
            cards: [
              {
                id: "people_systems",
                heading: "People choices and school systems",
                body: "One organization separates daily student choices from purchasing and collection systems.",
                sourceAliases: ["idea_1", "idea_2", "idea_5"],
                question: "Which ideas become easier or harder to understand in this organization?",
              },
              {
                id: "before_after_lunch",
                heading: "Before lunch and after lunch",
                body: "Another organization follows when waste is prevented, reused, or recovered.",
                sourceAliases: ["idea_3", "idea_4", "idea_6"],
                question: "What does this timeline reveal that the first organization hides?",
              },
            ],
            connections: [],
          },
        },
        {
          name: "add_collective_reasoning",
          input: {
            selectionToken,
            mode: "counterexample_challenge",
            title: "Test our strongest claims",
            cards: [
              {
                id: "claim",
                heading: "More choice reduces waste",
                body: "This claim connects portion choice with less uneaten food.",
                sourceAliases: ["idea_1"],
                question: "What evidence would show that more choice actually reduces total waste?",
                role: "claim",
              },
              {
                id: "counterexample",
                heading: "Choice could add packaging",
                body: "A choice system might reduce food waste while creating more packaging or a slower queue.",
                sourceAliases: ["idea_1", "idea_4"],
                question: "When could the proposed benefit create a different kind of cost?",
                role: "counterexample",
              },
            ],
            connections: [{ fromCardId: "counterexample", toCardId: "claim", label: "tests" }],
          },
        },
        {
          name: "add_content_visuals",
          input: {
            selectionToken,
            title: "A visual joke the class can challenge",
            safetyConfirmation: "classroom_safe_no_student_likeness_or_targeting",
            visuals: [
              {
                id: "lunch_plot_twist",
                format: "meme_card",
                title: "The lunch-line plot twist",
                caption:
                  "The meme connects less packaging with a faster lunch line, then asks the class to inspect that connection.",
                altText:
                  "A bright meme card with a recycling emoji. Top text says less packaging enters; bottom text says faster lunch line appears.",
                sourceAliases: ["idea_1", "idea_4"],
                discussionPrompt:
                  "What does this joke help us notice, and what does it oversimplify?",
                headline: "Less packaging enters",
                punchline: "Faster lunch line appears",
                emoji: "♻️",
                palette: "confetti",
              },
            ],
          },
        },
        {
          name: "add_group_decision_scaffold",
          input: {
            selectionToken,
            mode: "criteria_co_designer",
            title: "Criteria the class can edit and weight",
            entries: [
              {
                id: "access",
                heading: "Accessible to everyone",
                body: "The solution should work for different lunch routines and support needs.",
                sourceAliases: ["idea_2", "idea_4"],
                question: "How should the class define and observe accessibility?",
              },
              {
                id: "impact",
                heading: "Reduces total waste",
                body: "The class may want to consider food, packaging, and recovery together.",
                sourceAliases: ["idea_1", "idea_5"],
                question: "Which waste measures should count most to the class?",
              },
            ],
            criteria: [],
          },
        },
        {
          name: "add_learning_action_plan",
          input: {
            selectionToken,
            mode: "idea_to_experiment",
            title: "Turn an idea into a class experiment",
            cards: [
              {
                id: "prediction",
                heading: "Prediction",
                body: "Offering a smaller default portion may reduce uneaten food without reducing satisfaction.",
                sourceAliases: ["idea_1"],
                question:
                  "What change would the class predict in food waste and student experience?",
                role: "prediction",
              },
              {
                id: "evidence",
                heading: "Evidence to collect",
                body: "Observe leftover food, queue time, and whether students request more food.",
                sourceAliases: ["idea_1", "idea_4"],
                question: "Which evidence would distinguish success from a hidden trade-off?",
                role: "evidence need",
              },
              {
                id: "test",
                heading: "Small reversible test",
                body: "Try one lunch station for one week while keeping an easy path to request more.",
                sourceAliases: ["idea_1", "idea_4"],
                question: "What would make this test fair, safe, and easy to stop?",
                role: "proposed test",
              },
            ],
            connections: [
              { fromCardId: "prediction", toCardId: "evidence", label: "checked by" },
              { fromCardId: "evidence", toCardId: "test", label: "collected during" },
            ],
          },
        },
      ];
      const results: Record<string, unknown>[] = [];
      for (const move of moves) {
        const tool = window.__spaceScaleWebMcpTools[move.name];
        if (!tool) throw new Error(`${move.name} was not registered.`);
        results.push(await tool.execute(move.input, { signal: new AbortController().signal }));
      }
      return results;
    },
    { selectionToken: readResult.selectionToken as string },
  );
  expect(educationResults).toHaveLength(6);
  expect(educationResults.every((result) => result.changedCanvas === true)).toBe(true);
  expect(educationResults[0]?.additionCount).toBe(2);
  expect(educationResults[3]).toMatchObject({
    visualCount: 1,
    formats: ["meme_card"],
    privatelyStored: true,
    sourceLinkCount: 2,
  });
  expect(educationResults[4]?.consensusInferred).toBe(false);
  const educationItemCount = educationResults.reduce(
    (total, result) => total + (result.createdItemCount as number),
    0,
  );
  await expect(canvasItems).toHaveCount(13 + educationItemCount);
  await expect(page.locator('#drawing-area [data-creator-assistance="ai"]')).toHaveCount(0);
  await expect(page.locator("#drawing-area .creator-badge-ai")).toHaveCount(0);
  await expect(page.locator("#drawing-area .creator-badge").first()).toBeVisible();
  await expect(page.locator("#drawing-area")).not.toContainText("AI-assisted");
  let remainingEducationItems = 13 + educationItemCount;
  for (let index = educationResults.length - 1; index >= 0; index -= 1) {
    remainingEducationItems -= educationResults[index]?.createdItemCount as number;
    await page.waitForTimeout(300);
    await page.getByTestId("undo-button").click();
    await expect(canvasItems).toHaveCount(remainingEducationItems);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  }
  await expect(canvasItems).toHaveCount(13);

  const stageResultPromise = page.evaluate(
    ({ selectionToken }) => {
      const tool = window.__spaceScaleWebMcpTools.stage_collective_inquiry;
      if (!tool) throw new Error("The inquiry-staging tool was not registered.");
      return tool.execute(
        {
          selectionToken,
          mapTitle: "From isolated fixes to a school-wide learning loop",
          themes: [
            {
              id: "choice_and_demand",
              label: "Choice and demand",
              summary:
                "Reduce waste by matching portions and meals to what students will actually eat.",
              ideaAliases: ["idea_1", "idea_3", "idea_7"],
            },
            {
              id: "reuse_and_recovery",
              label: "Reuse and recovery",
              summary:
                "Keep food and materials in useful cycles instead of treating everything as rubbish.",
              ideaAliases: ["idea_2", "idea_5", "idea_6"],
            },
            {
              id: "feedback_and_flow",
              label: "Feedback and flow",
              summary:
                "Make waste and lunch-line friction visible so the class can improve the system together.",
              ideaAliases: ["idea_4", "idea_8"],
            },
          ],
          bridges: [
            {
              fromThemeId: "choice_and_demand",
              toThemeId: "feedback_and_flow",
              insight:
                "Daily feedback can help the kitchen predict demand while students see the effect of their choices.",
            },
            {
              fromThemeId: "reuse_and_recovery",
              toThemeId: "feedback_and_flow",
              insight:
                "A visible return and recovery system makes collective responsibility concrete and measurable.",
            },
          ],
          tension: {
            statement:
              "Convenient individual choice may reduce food waste while increasing packaging or slowing lunch service.",
            nextQuestion:
              "What small pilot would reduce total waste without making lunch less accessible or enjoyable?",
          },
        },
        { signal: new AbortController().signal },
      );
    },
    { selectionToken: readResult.selectionToken as string },
  );

  const preview = page.getByTestId("inquiry-preview-dialog");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Proposal · no changes yet");
  await expect(preview.locator(".inquiry-preview-theme")).toHaveCount(3);
  await preview.getByRole("button", { name: "Add map for the class" }).click();

  const stageResult = await stageResultPromise;
  expect(stageResult.status).toBe("participant_approved_and_added");
  const createdItemCount = stageResult.createdItemCount as number;
  expect(createdItemCount).toBeGreaterThan(0);
  await expect(canvasItems).toHaveCount(13 + createdItemCount);
  await expect(page.locator('#drawing-area [data-creator-assistance="ai"]')).toHaveCount(0);
  await expect(page.locator("#drawing-area .creator-badge-ai")).toHaveCount(0);
  await expect(page.locator("#drawing-area")).not.toContainText("AI-assisted");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  await page.getByTestId("undo-button").click();
  await expect(canvasItems).toHaveCount(13);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

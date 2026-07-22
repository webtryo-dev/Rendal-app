import { describe, expect, it } from "vitest";
import {
  PLAN_ORDER,
  isModelAllowed,
  isToolAllowed,
  normalizePlan,
  requiredPlanForModelTier,
  requiredPlanForTool,
} from "./capabilities.server";
import type { ModelTier } from "./types";

// One representative tool from each plan band (see TOOLS_ADDED_BY_PLAN).
const STARTER_TOOL = "search_products";
const GROWTH_TOOL = "create_shipping_zone";
const SCALE_TOOL = "generate_image";
const FOUNDER_TOOL = "publish_theme";

describe("normalizePlan", () => {
  it("passes every known plan through unchanged", () => {
    for (const plan of PLAN_ORDER) expect(normalizePlan(plan)).toBe(plan);
  });

  it("falls back to starter for an unrecognized plan string", () => {
    expect(normalizePlan("enterprise")).toBe("starter");
    expect(normalizePlan("GROWTH")).toBe("starter"); // case-sensitive by design
    expect(normalizePlan("")).toBe("starter");
  });

  it("falls back to starter for null/undefined", () => {
    expect(normalizePlan(null)).toBe("starter");
    expect(normalizePlan(undefined)).toBe("starter");
  });
});

describe("isModelAllowed", () => {
  // Full 4-plan x 3-tier matrix from PLAN_MODEL_CEILING:
  // starter/growth cap at standard, scale at premium, founder at flagship.
  const expected: Record<string, Record<ModelTier, boolean>> = {
    starter: { standard: true, premium: false, flagship: false },
    growth: { standard: true, premium: false, flagship: false },
    scale: { standard: true, premium: true, flagship: false },
    founder: { standard: true, premium: true, flagship: true },
  };

  for (const plan of PLAN_ORDER) {
    for (const tier of ["standard", "premium", "flagship"] as const) {
      it(`${plan} ${expected[plan][tier] ? "allows" : "denies"} ${tier}`, () => {
        expect(isModelAllowed(plan, tier)).toBe(expected[plan][tier]);
      });
    }
  }

  it("treats an unknown plan as starter (standard only)", () => {
    expect(isModelAllowed("bogus", "standard")).toBe(true);
    expect(isModelAllowed("bogus", "premium")).toBe(false);
    expect(isModelAllowed("bogus", "flagship")).toBe(false);
  });
});

describe("isToolAllowed", () => {
  // Plans are cumulative: each plan gets its own band plus everything below.
  const bands: Array<[tool: string, firstPlanWithIt: number]> = [
    [STARTER_TOOL, 0],
    [GROWTH_TOOL, 1],
    [SCALE_TOOL, 2],
    [FOUNDER_TOOL, 3],
  ];

  for (const [tool, firstIdx] of bands) {
    for (let planIdx = 0; planIdx < PLAN_ORDER.length; planIdx++) {
      const plan = PLAN_ORDER[planIdx];
      const allowed = planIdx >= firstIdx;
      it(`${plan} ${allowed ? "allows" : "denies"} ${tool}`, () => {
        expect(isToolAllowed(plan, tool)).toBe(allowed);
      });
    }
  }

  it("denies a tool name that is not in any plan's list, on every plan", () => {
    for (const plan of PLAN_ORDER) {
      expect(isToolAllowed(plan, "not_a_real_tool")).toBe(false);
    }
  });

  it("treats an unknown plan as starter", () => {
    expect(isToolAllowed("bogus", STARTER_TOOL)).toBe(true);
    expect(isToolAllowed("bogus", GROWTH_TOOL)).toBe(false);
  });
});

describe("requiredPlanForModelTier", () => {
  it("returns the lowest plan whose ceiling reaches the tier", () => {
    expect(requiredPlanForModelTier("standard")).toBe("starter");
    expect(requiredPlanForModelTier("premium")).toBe("scale");
    expect(requiredPlanForModelTier("flagship")).toBe("founder");
  });
});

describe("requiredPlanForTool", () => {
  it("returns the lowest plan that unlocks the tool", () => {
    expect(requiredPlanForTool(STARTER_TOOL)).toBe("starter");
    expect(requiredPlanForTool(GROWTH_TOOL)).toBe("growth");
    expect(requiredPlanForTool(SCALE_TOOL)).toBe("scale");
    expect(requiredPlanForTool(FOUNDER_TOOL)).toBe("founder");
  });

  it("returns null for a tool that is not in the map", () => {
    expect(requiredPlanForTool("not_a_real_tool")).toBeNull();
  });
});

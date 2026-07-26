import { describe, expect, it, vi } from "vitest";
import {
  PLAN_ORDER,
  isModelAllowed,
  isToolAllowed,
  normalizePlan,
  requiredPlanForModelTier,
  requiredPlanForTool,
} from "./capabilities.server";
import type { ModelTier } from "./types";
// Statically imported so the (slow) transitive load happens at module init,
// not inside a test body where it would trip the per-test timeout.
import { TOOL_DEFS } from "./tools.server";

// tools.server.ts pulls in the image tools, which import the Prisma client.
vi.mock("../db.server", () => ({ default: {} }));

const ALL_TOOL_NAMES = TOOL_DEFS.map((d) => d.name);

// One representative tool from each plan band (see TOOLS_ADDED_BY_PLAN).
const STARTER_TOOL = "search_products";
const GROWTH_TOOL = "create_shipping_zone";
const SCALE_TOOL = "generate_image";
const FOUNDER_TOOL = "update_shop_policies";

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

// Regression guard: a tool that exists but was never assigned to a plan band
// is denied on EVERY plan (isToolAllowed denies unknown names), including
// Founder. That silently shipped for the variant/option/product-image tools
// and the shipping deletes — merchants on the top plan were told the feature
// "isn't available on your plan" for tools every plan should have had.
describe("TOOL_DEFS ↔ plan-map drift guard", () => {
  it("assigns every defined tool to at least one plan", () => {
    const unassigned = ALL_TOOL_NAMES.filter((name) => requiredPlanForTool(name) === null);
    expect(unassigned).toEqual([]);
  });

  it("grants the top plan every defined tool", () => {
    const topPlan = PLAN_ORDER[PLAN_ORDER.length - 1];
    const denied = ALL_TOOL_NAMES.filter((name) => !isToolAllowed(topPlan, name));
    expect(denied).toEqual([]);
  });
});

describe("plans are strictly cumulative", () => {
  it("gives each plan every tool unlocked by the plans below it", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = PLAN_ORDER[i - 1];
      const higher = PLAN_ORDER[i];
      const lost = ALL_TOOL_NAMES.filter(
        (n) => isToolAllowed(lower, n) && !isToolAllowed(higher, n),
      );
      expect(lost, `${higher} must inherit everything ${lower} has`).toEqual([]);
    }
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

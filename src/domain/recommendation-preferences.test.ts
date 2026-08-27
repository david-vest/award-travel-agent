import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANKING_PREFERENCE,
  RANKING_EXPERIENCE_WEIGHTS,
  RANKING_LEVELS,
  defaultRankingPreference,
  rankingLevelLabel,
} from "./recommendation-preferences";

describe("recommendation preference levels", () => {
  it("defines one accessible label for every position on the five-step control", () => {
    expect(RANKING_LEVELS.map((level) => level.value)).toEqual(RANKING_EXPERIENCE_WEIGHTS);
    expect(RANKING_LEVELS.map((level) => rankingLevelLabel(level.value))).toEqual(
      RANKING_LEVELS.map((level) => level.label),
    );
  });

  it("returns a fresh balanced preference for each form reset", () => {
    const first = defaultRankingPreference();
    first.priorities.push("schedule");

    expect(defaultRankingPreference()).toEqual(DEFAULT_RANKING_PREFERENCE);
  });
});

import { describe, expect, test } from "bun:test";

import { catalogRefreshTasks } from "./catalogRefresh";

describe("catalogRefreshTasks", () => {
  test("a config rebuild re-reads every list a config file can carry", () => {
    // Agents, commands, skills, MCP servers, plugins and providers all live
    // in config, and OpenChamber's own plugin injection is one of them.
    expect(catalogRefreshTasks("config")).toHaveLength(6);
  });

  test("a single-catalog rebuild re-reads only that list", () => {
    for (const kind of ["agent", "command", "skill", "plugin", "provider", "credential"] as const) {
      expect(catalogRefreshTasks(kind)).toHaveLength(1);
    }
  });

  test("projects belong to the sync stores, not to the settings lists", () => {
    expect(catalogRefreshTasks("project")).toEqual([]);
  });
});

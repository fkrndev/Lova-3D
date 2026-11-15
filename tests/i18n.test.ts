import { beforeEach, describe, expect, it } from "vitest";
import en from "../src/i18n/en";
import id from "../src/i18n/id";
import { i18n, t } from "../src/i18n/index.svelte";
import { resetStore } from "./helpers";

beforeEach(resetStore);

describe("i18n", () => {
  it("keeps EN and ID dictionaries key-identical (no missing translations)", () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
  });

  it("has no empty values", () => {
    for (const [k, v] of Object.entries(en)) expect(v.length, `en.${k}`).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(id)) expect(v.length, `id.${k}`).toBeGreaterThan(0);
  });

  it("interpolates {params}", () => {
    expect(t("log.sceneSaved", { path: "C:/x.json" })).toContain("C:/x.json");
    expect(t("log.removeObjs", { count: 3 })).toContain("3");
  });

  it("switches locale and persists the choice", () => {
    expect(i18n.locale).toBe("en");
    expect(t("toolbar.save")).toBe("Save");
    i18n.set("id");
    expect(t("toolbar.save")).toBe("Simpan");
    expect(localStorage.getItem("lova.locale")).toBe("id");
    i18n.set("en");
    expect(t("toolbar.save")).toBe("Save");
  });

  it("falls back to the key for unknown lookups", () => {
    expect(t("no.such.key" as never)).toBe("no.such.key");
  });
});

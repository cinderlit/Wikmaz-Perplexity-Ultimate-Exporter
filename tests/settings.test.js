const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ExportSettings = require("../lib/settings.js");

describe("sanitizeExportRoot", () => {
  it("defaults empty input to perplexity-mining path", () => {
    assert.equal(
      ExportSettings.sanitizeExportRoot(""),
      "perplexity-mining/Perplexity_Export"
    );
  });

  it("strips leading and trailing slashes", () => {
    assert.equal(
      ExportSettings.sanitizeExportRoot("/my-folder/exports/"),
      "my-folder/exports"
    );
  });

  it("removes path traversal segments", () => {
    assert.equal(
      ExportSettings.sanitizeExportRoot("../../etc/Perplexity_Export"),
      "etc/Perplexity_Export"
    );
  });

  it("sanitizes unsafe characters in segments", () => {
    assert.equal(
      ExportSettings.sanitizeExportRoot("perplexity-mining/Perplexity Export!"),
      "perplexity-mining/Perplexity Export_"
    );
  });
});

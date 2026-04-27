const path = require("path");
function loadProModule() {
  try {
    return require(path.resolve(__dirname, "..", "..", "packages", "pro", "cli", "adapter", "update-checker.js"));
  } catch {
    return null;
  }
}

const mod = loadProModule();

class AdapterUpdateChecker {
  constructor() {
    throw new Error("AdapterUpdateChecker is a Pro module. Install the Pro package to use this feature.");
  }
}

module.exports = mod && mod.AdapterUpdateChecker ? mod : { AdapterUpdateChecker };

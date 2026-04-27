const path = require("path");
const { isProUser } = require(path.resolve(__dirname, "..", "license-check.js"));

async function getCurrentLicense() {
  const valid = await isProUser();
  return { valid, plan: valid ? "pro" : "free" };
}

module.exports = { getCurrentLicense };

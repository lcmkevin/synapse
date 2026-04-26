const util = require("util");

class SynapseError extends Error {
  constructor({ code, message, suggestion, commandHint, details, exitCode } = {}) {
    super(String(message || "Unexpected error"));
    this.name = "SynapseError";
    this.code = String(code || "E_UNKNOWN");
    this.suggestion = String(suggestion || "");
    this.commandHint = typeof commandHint === "string" && commandHint.trim() ? commandHint.trim() : undefined;
    this.details = details;
    this.exitCode = Number.isFinite(exitCode) ? exitCode : 1;
  }
}

function isDebugEnabled() {
  const raw = process.env.SYNAPSE_DEBUG;
  return raw === "1" || raw === "true";
}

function getErrMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  return "";
}

function getErrCode(err) {
  if (!err || typeof err !== "object") return "";
  const code = err.code;
  return typeof code === "string" ? code : "";
}

function toSynapseError(err) {
  if (err instanceof SynapseError) return err;

  const message = getErrMessage(err);
  const code = getErrCode(err);

  if (message.includes('Run "synapse init" first') || message.includes("synapse not initialized")) {
    return new SynapseError({
      code: "E_NOT_INITIALIZED",
      message: "Synapse is not initialized in this folder.",
      suggestion: "Initialize Synapse once, then retry your command.",
      commandHint: "synapse init",
    });
  }

  if (code === "ENOENT") {
    return new SynapseError({
      code: "E_NOT_FOUND",
      message: message || "Required file or folder was not found.",
      suggestion: "Double-check the workspace folder and required paths exist.",
      details: { code },
    });
  }

  if (code === "EACCES" || code === "EPERM") {
    return new SynapseError({
      code: "E_PERMISSION",
      message: message || "Permission denied while reading or writing files.",
      suggestion: "Check folder permissions, then retry. On Windows, try running your terminal as Administrator.",
      details: { code },
    });
  }

  if (code === "EADDRINUSE") {
    return new SynapseError({
      code: "E_PORT_IN_USE",
      message: "Port is already in use.",
      suggestion: "Stop the other process using the port, or pick a different port.",
      details: { code },
    });
  }

  if (message.includes("Unexpected token") && message.toLowerCase().includes("json")) {
    return new SynapseError({
      code: "E_BAD_JSON",
      message: "Failed to parse JSON configuration.",
      suggestion: "Fix the JSON syntax in your config file (or delete it to regenerate).",
      details: { originalMessage: message },
    });
  }

  return new SynapseError({
    code: "E_UNKNOWN",
    message: message || "Unexpected error.",
    suggestion: isDebugEnabled() ? "See details below." : "Re-run with SYNAPSE_DEBUG=1 to see the full stack trace.",
    details: err,
  });
}

function printCliError(err, { label } = {}) {
  const e = toSynapseError(err);
  const prefix = label ? `${String(label).trim()}: ` : "";

  process.stderr.write(`\n❌ ${prefix}${e.message}\n`);
  if (e.suggestion) process.stderr.write(`   💡 ${e.suggestion}\n`);
  if (e.commandHint) process.stderr.write(`   🔧 Run: ${e.commandHint}\n`);

  if (isDebugEnabled()) {
    const stack = err && err.stack ? String(err.stack) : "";
    if (stack) process.stderr.write(`\n${stack}\n`);
    else process.stderr.write(`\n${util.inspect(e.details, { depth: 6, colors: false })}\n`);
  }

  process.stderr.write("\n");
  process.exitCode = e.exitCode;
  return e;
}

module.exports = { SynapseError, toSynapseError, printCliError };

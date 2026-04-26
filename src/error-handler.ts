export type SynapseErrorInit = {
  code?: string;
  message?: string;
  suggestion?: string;
  commandHint?: string;
  details?: unknown;
  exitCode?: number;
};

export class SynapseError extends Error {
  public readonly code: string;
  public readonly suggestion: string;
  public readonly commandHint?: string;
  public readonly details?: unknown;
  public readonly exitCode: number;

  public constructor(init: SynapseErrorInit = {}) {
    super(String(init.message || "Unexpected error"));
    this.name = "SynapseError";
    this.code = String(init.code || "E_UNKNOWN");
    this.suggestion = String(init.suggestion || "");
    this.commandHint = typeof init.commandHint === "string" && init.commandHint.trim() ? init.commandHint.trim() : undefined;
    this.details = init.details;
    this.exitCode = Number.isFinite(init.exitCode) ? Number(init.exitCode) : 1;
  }
}

function isDebugEnabled(): boolean {
  const raw = process.env.SYNAPSE_DEBUG;
  return raw === "1" || raw === "true";
}

function getErrMessage(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof (err as any).message === "string") return (err as any).message;
  return "";
}

function getErrCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const code = (err as any).code;
  return typeof code === "string" ? code : "";
}

export function toSynapseError(err: unknown): SynapseError {
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

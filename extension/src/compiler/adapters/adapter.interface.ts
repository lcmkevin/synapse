// NEW: Synapse adapter interface

export interface SynapseRule {
  id: string;
  name: string;
  description?: string;
  content: string;
  constraints?: string[];
  skills?: string[];
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    version: number;
  };
}

export interface CompilationResult {
  success: boolean;
  outputPath?: string;
  errors?: string[];
  warnings?: string[];
  targetIDE: string;
}

export interface IDEAdapter {
  id: string;
  name: string;
  version: string;
  targetExtension: string;
  targetFolder: string;

  compile(rule: SynapseRule, options?: { minify?: boolean }): Promise<string>;
  parse(content: string, filePath: string): Promise<SynapseRule>;
  validate(compiled: string): Promise<{ valid: boolean; errors?: string[] }>;
  getInstallInstructions(): string;
}


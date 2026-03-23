export interface PluginAPI {
  registerTool(tool: ToolDefinition): void;
  registerCommand(command: CommandDefinition): void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  execute: (id: string, params: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface ParameterDef {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface CommandDefinition {
  name: string;
  description: string;
  run: (args: string) => Promise<string>;
}

export interface ToolResult {
  content: string;
  error?: string;
}

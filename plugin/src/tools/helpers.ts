import type { McpToolResult, ToolResult } from '../types.js';

export function text(result: ToolResult | Promise<ToolResult>): McpToolResult | Promise<McpToolResult> {
  if (result instanceof Promise) {
    return result.then(r => wrap(r));
  }
  return wrap(result);
}

function wrap(result: ToolResult): McpToolResult {
  if (result.error) {
    return { content: [{ type: 'text', text: 'Error: ' + result.error }], isError: true };
  }
  return { content: [{ type: 'text', text: result.content }] };
}
